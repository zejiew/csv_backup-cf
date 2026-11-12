#!/usr/bin/env node
// 零依赖本地预览服务器：不需要 wrangler / npm install。
//
//   node dev.mjs            # http://127.0.0.1:8788
//   PORT=9000 node dev.mjs
//
// 做的事：
//   · 把 public/ 当静态目录服务（/、/app.js、/style.css）
//   · 把 /api/* 交给 functions/_lib/router.js，跟线上 Pages Functions 同一份代码
//   · 用一个存盘的 JSON 当 KV，重启不丢数据（存 dev-data.json）
//
// 它不是 wrangler 的替代品（不模拟边缘缓存、不支持 wrangler.toml 绑定），
// 只是让你在装不上依赖时也能把界面点一遍。

import { createServer } from "node:http";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { handle } from "./functions/_lib/router.js";

const ROOT = resolve(import.meta.dirname, "public");
const DATA_FILE = resolve(import.meta.dirname, "dev-data.json");
const PORT = Number(process.env.PORT || 8788);

/* ---------------- 存盘版 KV ---------------- */
// 只实现 router/store 用到的那几个方法，行为尽量贴近真实 KV：
// list 分页、metadata 1024B、value 25MiB 上限都照做。
const KEY_LIMIT = 512;
const VALUE_LIMIT = 25 * 1024 * 1024;
const META_LIMIT = 1024;

// Cloudflare KV 的 cacheTtl 最小 60 秒。传 0（想「绕过缓存」）会被判为非法参数，
// 线上直接抛错——曾经因此让下载 / 删除 / 导出全部返回 500，而本地 mock 不校验，
// 所以测不出来。这里照着线上的规则拦一道，让同类问题在本地就暴露。
const CACHE_TTL_MIN = 60;

function assertReadOptions(options) {
  if (!options || options.cacheTtl === undefined) return;
  const ttl = options.cacheTtl;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
    throw new Error(
      `KV cacheTtl 必须是数字，收到 ${JSON.stringify(ttl)}（线上同样会报错）`
    );
  }
  if (ttl < CACHE_TTL_MIN) {
    throw new Error(
      `KV cacheTtl 不能小于 ${CACHE_TTL_MIN} 秒（收到 ${ttl}）。` +
      `Cloudflare KV 不接受 0 或更小的值，线上会直接 500。`
    );
  }
}

let db = { keys: {} };
if (existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    console.warn("[dev] dev-data.json 解析失败，从空库开始");
  }
}

let pending = null;
function persist() {
  // 合并短时间内的多次写，避免大库时每条都落盘
  if (pending) clearTimeout(pending);
  pending = setTimeout(async () => {
    pending = null;
    await writeFile(DATA_FILE, JSON.stringify(db)).catch((e) =>
      console.error("[dev] 落盘失败:", e.message)
    );
  }, 120);
}

const kv = {
  async get(key, options) {
    assertReadOptions(options);
    const entry = db.keys[key];
    if (!entry) return null;
    const bytes = Buffer.from(entry.b64 || "", "base64");
    // 没传 type 时 KV 返回字符串（UTF-8 解码）
    if (options?.type === "arrayBuffer") {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (options?.type === "json") return JSON.parse(bytes.toString("utf8"));
    return bytes.toString("utf8");
  },
  async getWithMetadata(key, options) {
    assertReadOptions(options);
    const entry = db.keys[key];
    if (!entry) return { value: null, metadata: null };
    const bytes = Buffer.from(entry.b64 || "", "base64");
    let value;
    if (options?.type === "arrayBuffer") {
      value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else if (options?.type === "json") {
      value = JSON.parse(bytes.toString("utf8"));
    } else {
      value = bytes.toString("utf8");
    }
    return { value, metadata: entry.metadata ?? null };
  },
  async put(key, value, options = {}) {
    if (typeof key !== "string" || key.length > KEY_LIMIT) {
      throw new Error(`KV key 过长（上限 ${KEY_LIMIT}B）`);
    }
    // 真实 KV 接受 string / ArrayBuffer / ReadableStream，这里都先落成字节
    let bytes;
    if (typeof value === "string") {
      bytes = Buffer.from(value, "utf8");
    } else if (value instanceof Uint8Array) {
      bytes = Buffer.from(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = Buffer.from(new Uint8Array(value));
    } else if (value && typeof value.getReader === "function") {
      const chunks = [];
      const reader = value.getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks);
    } else {
      bytes = Buffer.from(String(value), "utf8");
    }
    if (bytes.length > VALUE_LIMIT) throw new Error("KV value 超过 25MiB 上限");
    if (options.metadata) {
      const size = Buffer.byteLength(JSON.stringify(options.metadata), "utf8");
      if (size > META_LIMIT) throw new Error(`KV metadata 超过 ${META_LIMIT}B 上限`);
    }
    db.keys[key] = {
      b64: bytes.toString("base64"),
      metadata: options.metadata ? JSON.parse(JSON.stringify(options.metadata)) : null,
      expiration: options.expiration || null,
    };
    persist();
  },
  async delete(key) {
    delete db.keys[key];
    persist();
  },
  async list(options = {}) {
    const prefix = options.prefix || "";
    const limit = Math.min(Number(options.limit) || 1000, 1000);
    const now = Date.now() / 1000;
    const names = Object.keys(db.keys)
      .filter((k) => k.startsWith(prefix))
      .filter((k) => {
        const exp = db.keys[k].expiration;
        return !exp || exp > now; // 过期的不再出现在列表里
      })
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

const env = {
  CSV_KV: kv,
  ACCESS_PASSWORD: process.env.ACCESS_PASSWORD || "dev-password",
  API_TOKEN: process.env.API_TOKEN || "",
  SESSION_SECRET: process.env.SESSION_SECRET || "dev-session-secret-change-me",
  PUBLIC_ORIGIN: "",
  // 本地默认把真实错误带出来，否则 500 只会显示「服务器内部错误」，
  // 排查时得去翻日志。线上不设这个变量，保持对外只给通用提示。
  DEBUG_ERRORS: process.env.DEBUG_ERRORS || "1",
};

// DEV_UNCONFIGURED=1 时假装还没在面板里配好，用来看首次部署那个「还差一步」的页面
if (process.env.DEV_UNCONFIGURED === "1") {
  delete env.CSV_KV;
  delete env.ACCESS_PASSWORD;
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  if (rel === "/") rel = "/index.html";
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT)) return null;         // 防目录穿越
  try {
    const body = await readFile(full);
    return { body, type: MIME[extname(full).toLowerCase()] || "application/octet-stream" };
  } catch {
    return null;
  }
}

/* ---------------- 适配 Pages 的 context ---------------- */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");

  if (!isApi) {
    const file = await serveStatic(url.pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
    res.end(file.body);
    return;
  }

  // 构造标准 Request，交给和线上完全相同的 router
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
    response = await handle({ request, env, params: {}, next: async () => new Response("", { status: 404 }) });
  } catch (err) {
    console.error("[dev] 未捕获异常:", err);
    response = new Response(JSON.stringify({ ok: false, code: "dev_error", message: err.message }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(PORT, () => {
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`\n  CSV 备份柜（本地预览）\n`);
  console.log(`  ${base}`);
  console.log(`  口令：${process.env.ACCESS_PASSWORD || (process.env.DEV_UNCONFIGURED === "1" ? "（未设置）" : "dev-password")}`);
  console.log(`  数据：${DATA_FILE}\n`);
  if (!process.env.ACCESS_PASSWORD) {
    console.log("  （提示：设 ACCESS_PASSWORD 环境变量可换口令）");
  }
  if (process.env.DEV_UNCONFIGURED === "1") {
    console.log("  （DEV_UNCONFIGURED=1：模拟首次部署、还没绑 KV / 设口令的状态）\n");
  } else {
    console.log("");
  }
});
