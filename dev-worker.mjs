#!/usr/bin/env node
// 本地预览 Workers 形态（src/index.js + ASSETS 静态资产）。
//
// 与 dev.mjs 的区别：dev.mjs 走 Pages 的 functions/ 入口；
// 这个走 src/index.js，模拟「连 GitHub 建 Worker」那条部署路径，
// 用来确认 wrangler.jsonc 里 run_worker_first 的分流逻辑没问题。
//
//   node dev-worker.mjs            # http://127.0.0.1:8789
//   DEV_UNCONFIGURED=1 node dev-worker.mjs

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import worker from "./src/index.js";

const ROOT = resolve(import.meta.dirname, "public");
const DATA_FILE = resolve(import.meta.dirname, "dev-data.json");
const PORT = Number(process.env.PORT || 8789);

const VALUE_LIMIT = 25 * 1024 * 1024;
const META_LIMIT = 1024;
const KEY_LIMIT = 512;

let db = { keys: {} };
if (existsSync(DATA_FILE)) {
  try { db = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch { /* 空库 */ }
}

let pending = null;
function persist() {
  if (pending) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    await writeFile(DATA_FILE, JSON.stringify(db)).catch(() => {});
  }, 120);
}

// 与 dev.mjs 相同的存盘 KV（base64 存字节）
const kv = {
  async get(key, options) {
    const e = db.keys[key];
    if (!e) return null;
    const bytes = Buffer.from(e.b64 || "", "base64");
    if (options?.type === "arrayBuffer") {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return bytes.toString("utf8");
  },
  async getWithMetadata(key, options) {
    const e = db.keys[key];
    if (!e) return { value: null, metadata: null };
    const bytes = Buffer.from(e.b64 || "", "base64");
    const value =
      options?.type === "arrayBuffer"
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : bytes.toString("utf8");
    return { value, metadata: e.metadata ?? null };
  },
  async put(key, value, options = {}) {
    if (key.length > KEY_LIMIT) throw new Error("key 过长");
    let bytes;
    if (typeof value === "string") bytes = Buffer.from(value, "utf8");
    else if (value instanceof Uint8Array) bytes = Buffer.from(value);
    else if (value instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(value));
    else bytes = Buffer.from(String(value), "utf8");
    if (bytes.length > VALUE_LIMIT) throw new Error("value 超过 25MiB");
    if (options.metadata) {
      const size = Buffer.byteLength(JSON.stringify(options.metadata));
      if (size > META_LIMIT) throw new Error(`metadata 超过 ${META_LIMIT}B`);
    }
    db.keys[key] = {
      b64: bytes.toString("base64"),
      metadata: options.metadata ? JSON.parse(JSON.stringify(options.metadata)) : null,
      expiration: options.expiration || null,
    };
    persist();
  },
  async delete(key) { delete db.keys[key]; persist(); },
  async list(options = {}) {
    const prefix = options.prefix || "";
    const limit = Math.min(Number(options.limit) || 1000, 1000);
    const now = Date.now() / 1000;
    const names = Object.keys(db.keys)
      .filter((k) => k.startsWith(prefix))
      .filter((k) => !db.keys[k].expiration || db.keys[k].expiration > now)
      .sort();
    const start = options.cursor ? names.indexOf(options.cursor) + 1 : 0;
    const slice = names.slice(start, start + limit);
    const done = start + slice.length >= names.length;
    return {
      keys: slice.map((name) => ({
        name,
        expiration: db.keys[name].expiration || undefined,
        metadata: db.keys[name].metadata ?? undefined,
      })),
      list_complete: done,
      cursor: done ? undefined : slice[slice.length - 1],
    };
  },
};

// 模拟 ASSETS 绑定：直接读 public/，并套用 Cloudflare 的 index.html 回落规则
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const assets = {
  async fetch(request) {
    const url = typeof request === "string" ? new URL(request) : new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const full = normalize(join(ROOT, rel));
    if (!full.startsWith(ROOT)) return new Response("forbidden", { status: 403 });
    try {
      const body = await readFile(full);
      return new Response(body, {
        headers: { "content-type": MIME[extname(full).toLowerCase()] || "application/octet-stream" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  },
};

const env = {
  CSV_KV: kv,
  ASSETS: assets,
  ACCESS_PASSWORD: process.env.ACCESS_PASSWORD || "dev-password",
  API_TOKEN: process.env.API_TOKEN || "",
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-session-secret-change-me",
  PUBLIC_ORIGIN: "",
  _assetHits: [],
};

if (process.env.DEV_UNCONFIGURED === "1") {
  delete env.CSV_KV;
  delete env.ACCESS_PASSWORD;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(url.href, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
    duplex: "half",
  });

  let response;
  try {
    response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
  } catch (err) {
    response = new Response(
      JSON.stringify({ ok: false, code: "dev_error", message: err.message }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(PORT, () => {
  console.log(`\n  CSV 备份柜（Workers 形态预览）\n`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  口令：${process.env.ACCESS_PASSWORD || (process.env.DEV_UNCONFIGURED === "1" ? "（未设置）" : "dev-password")}`);
  console.log(`  数据：${DATA_FILE}\n`);
});
