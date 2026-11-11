// KV 数据模型。
//
//   f:<fileId>                当前版本正文；metadata 里放全部展示信息
//   v:<fileId>:<序号>          历史版本正文
//   t:<fileId>                回收站（软删除）
//   _sys:fail:<ip摘要>         登录失败计数（15 分钟自动过期）
//
// 关键点：列表全靠 list({prefix:"f:"}) 返回的 metadata，不做 N+1 次 get()。
// 免费版每天 10 万次读、1000 次写，这个设计让「打开页面看列表」只花 1 次读。

import { LIMITS } from "./config.js";
import { HttpError } from "./http.js";

const K_FILE = "f:";
const K_VER = "v:";
const K_TRASH = "t:";

const pad = (n, w = 6) => String(n).padStart(w, "0");

export function newId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

// ---------------- 文件名

/**
 * 归一路径为「扁平但保留目录信息」的显示名：去掉控制字符、路径穿越、
 * 重复分隔符，并限制长度。只影响展示，真实存储靠 fileId。
 */
export function sanitizeName(input) {
  let s = String(input || "").replace(/\\/g, "/").trim();
  s = s
    .split("/")
    .map((seg) => seg.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  if (!s) throw new HttpError(400, "bad_name", "文件名不能为空");
  if (s.length > LIMITS.maxNameChars) {
    const dot = s.lastIndexOf(".");
    const cut = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
    s = s.slice(0, LIMITS.maxNameChars - cut.length) + cut;
  }
  return s;
}

export function extensionOf(name) {
  const base = String(name).split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const CSV_LIKE = new Set(["csv", "tsv", "txt", "json", "md", "log", "ndjson"]);
export function isCsvLike(name) {
  return CSV_LIKE.has(extensionOf(name));
}

// ---------------- 摘要

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 低成本预览：取前若干行做列表里的小提示，不额外占一个 KV 值 */
export function peekText(bytes, maxLines = 4, maxChars = 480) {
  const slice = bytes.subarray(0, 4096);
  let text;
  try {
    // 账本类 CSV 常见 UTF-8 BOM（Excel 友好），预览时剥掉
    text = new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
  const bin = text.slice(0, 512);
  // 二进制判定：出现 NUL 或大量控制字符就放弃预览
  let ctrl = 0;
  for (const ch of bin) {
    const c = ch.charCodeAt(0);
    if (c === 0) return "";
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  if (bin && ctrl / bin.length > 0.02) return "";
  return text.split(/\r?\n/).slice(0, maxLines).join("\n").slice(0, maxChars);
}

// ---------------- 元数据

/**
 * 压缩成 KV metadata（上限 1024B）。键名刻意短，为中文文件名留空间。
 */
function toMeta(m) {
  return {
    n: m.name,
    z: m.size,
    h: m.sha256,
    c: m.created,
    u: m.updated,
    v: m.versionCount || 0,
    g: m.tags || [],
    p: m.preview || "",
  };
}

function fromMeta(id, meta, opts = {}) {
  const m = meta || {};
  return {
    id,
    name: m.n || "(未命名)",
    size: Number(m.z) || 0,
    sha256: m.h || "",
    created: Number(m.c) || 0,
    updated: Number(m.u) || 0,
    versionCount: Number(m.v) || 0,
    tags: Array.isArray(m.g) ? m.g : [],
    preview: typeof m.p === "string" ? m.p : "",
    trashedAt: opts.trashedAt || 0,
    trashedFrom: opts.trashedFrom || "",
  };
}

function metaBytes(meta) {
  return new TextEncoder().encode(JSON.stringify(meta)).length;
}

function assertMetaFits(meta) {
  const n = metaBytes(meta);
  if (n > 1024) {
    throw new HttpError(
      400,
      "meta_too_large",
      `元数据超限（${n}B / 1024B），请缩短文件名或减少标签`
    );
  }
}

// ---------------- 列表

/**
 * 遍历某个前缀下的全部 key。
 * list 一次最多 1000 条，必须跟随 cursor；不能只看 keys 为空就停
 * （过期条目会以墓碑形式占位）。
 */
async function listAll(kv, prefix) {
  const out = [];
  let cursor;
  for (let guard = 0; guard < 50; guard++) {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys || []) out.push(k);
    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out;
}

export async function listFiles(env) {
  const keys = await listAll(env.CSV_KV, K_FILE);
  return keys
    .map((k) => fromMeta(k.name.slice(K_FILE.length), k.metadata))
    .sort((a, b) => b.updated - a.updated);
}

export async function listTrash(env) {
  const keys = await listAll(env.CSV_KV, K_TRASH);
  return keys
    .map((k) => {
      const meta = k.metadata || {};
      const t = Number(meta.t) || 0;
      return fromMeta(k.name.slice(K_TRASH.length), meta, {
        trashedAt: t,
        trashedFrom: meta.d || "",
      });
    })
    .sort((a, b) => b.trashedAt - a.trashedAt);
}

// ---------------- 单个文件

export async function getFile(env, id) {
  const { value, metadata } = await env.CSV_KV.getWithMetadata(K_FILE + id, {
    type: "arrayBuffer",
    // 刚写入后立刻读要看到最新结果，不能用默认 60s 缓存
    cacheTtl: 0,
  });
  if (!value) return null;
  return { bytes: new Uint8Array(value), meta: fromMeta(id, metadata) };
}

export async function getFileMeta(env, id) {
  const { metadata } = await env.CSV_KV.getWithMetadata(K_FILE + id, {
    type: "arrayBuffer",
    cacheTtl: 0,
  });
  if (!metadata) return null;
  return fromMeta(id, metadata);
}

export async function listVersions(env, id) {
  const keys = await listAll(env.CSV_KV, K_VER + id + ":");
  return keys
    .map((k) => {
      const m = k.metadata || {};
      return {
        seq: Number(k.name.slice((K_VER + id + ":").length)) || 0,
        key: k.name,
        size: Number(m.z) || 0,
        sha256: m.h || "",
        savedAt: Number(m.u) || 0,
        note: m.o || "",
      };
    })
    .sort((a, b) => b.seq - a.seq);
}

export async function getVersion(env, id, seq) {
  const key = `${K_VER}${id}:${pad(seq)}`;
  const { value, metadata } = await env.CSV_KV.getWithMetadata(key, {
    type: "arrayBuffer",
    cacheTtl: 0,
  });
  if (!value) return null;
  return { bytes: new Uint8Array(value), meta: fromMeta(id, metadata) };
}

// ---------------- 写入

/**
 * 存入一个新文件，或覆盖同名文件的当前版本。
 * sameName=true（默认）时覆盖同名文件的当前版本并留旧版；
 * 否则永远新建，重名自动加 (2)(3)。
 */
export async function saveFile(env, { name, bytes, tags, sameName = true, note = "上传" }) {
  const cleanName = sanitizeName(name);
  const digest = await sha256Hex(bytes);
  const now = Date.now();
  const existing = await listFiles(env);
  const same = existing.find((f) => f.name.toLowerCase() === cleanName.toLowerCase());

  if (same && sameName) {
    if (same.sha256 === digest) {
      return { action: "unchanged", file: same };
    }
    const cur = await getFile(env, same.id);
    if (cur) {
      const seq = (await listVersions(env, same.id)).reduce((m, v) => Math.max(m, v.seq), 0) + 1;
      await env.CSV_KV.put(`${K_VER}${same.id}:${pad(seq)}`, cur.bytes, {
        metadata: {
          n: same.name,
          z: cur.bytes.byteLength,
          h: same.sha256,
          c: same.created,
          u: now,
          o: note,
        },
      });
      await pruneVersions(env, same.id);
    }
    const meta = {
      name: same.name,
      size: bytes.byteLength,
      sha256: digest,
      created: same.created,
      updated: now,
      versionCount: same.versionCount + 1,
      tags: tags?.length ? tags : same.tags,
      preview: peekText(bytes),
    };
    assertMetaFits(toMeta(meta));
    await env.CSV_KV.put(K_FILE + same.id, bytes, { metadata: toMeta(meta) });
    return { action: "versioned", file: { ...same, ...meta, id: same.id } };
  }

  const finalName = same ? uniqueName(cleanName, existing) : cleanName;
  const dup = existing.find((f) => f.sha256 === digest);
  const id = newId();
  const meta = {
    name: finalName,
    size: bytes.byteLength,
    sha256: digest,
    created: now,
    updated: now,
    versionCount: 0,
    tags: tags || [],
    preview: peekText(bytes),
  };
  assertMetaFits(toMeta(meta));
  await env.CSV_KV.put(K_FILE + id, bytes, { metadata: toMeta(meta) });
  return { action: dup ? "created_duplicate" : "created", file: { ...meta, id } };
}

function uniqueName(name, existing) {
  const taken = new Set(existing.map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

async function pruneVersions(env, id) {
  const versions = await listVersions(env, id);
  if (versions.length <= LIMITS.maxVersions) return;
  // 序号小的最旧，超出保留数的从旧端删
  const doomed = versions.slice(LIMITS.maxVersions);
  for (const v of doomed) await env.CSV_KV.delete(v.key);
}

export async function updateFileMeta(env, id, { name, tags }) {
  const cur = await getFile(env, id);
  if (!cur) throw new HttpError(404, "not_found", "文件不存在");
  const next = { ...cur.meta };
  if (name != null) next.name = sanitizeName(name);
  if (tags != null) next.tags = normalizeTags(tags);
  const meta = toMeta(next);
  assertMetaFits(meta);
  // KV 无法只改 metadata，必须重写值（计 1 次写）
  await env.CSV_KV.put(K_FILE + id, cur.bytes, { metadata: meta });
  return { ...next, id };
}

export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[,，\s]+/);
  const out = [];
  for (const t of raw) {
    const v = String(t).trim().slice(0, LIMITS.maxTagChars);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= LIMITS.maxTags) break;
  }
  return out;
}

/** 软删除：正文搬到回收站，随时可取回 */
export async function trashFile(env, id) {
  const cur = await getFile(env, id);
  if (!cur) throw new HttpError(404, "not_found", "文件不存在");
  const now = Date.now();
  const meta = { ...toMeta(cur.meta), t: now, d: id };
  assertMetaFits(meta);
  await env.CSV_KV.put(K_TRASH + id, cur.bytes, { metadata: meta });
  await env.CSV_KV.delete(K_FILE + id);
  return { id, trashedAt: now };
}

export async function restoreFromTrash(env, id) {
  const { value, metadata } = await env.CSV_KV.getWithMetadata(K_TRASH + id, {
    type: "arrayBuffer",
    cacheTtl: 0,
  });
  if (!value) throw new HttpError(404, "not_found", "回收站里没有这个文件");
  const bytes = new Uint8Array(value);
  const m = metadata || {};
  const now = Date.now();
  const meta = {
    ...m,
    u: now,
  };
  delete meta.t;
  delete meta.d;
  assertMetaFits(meta);
  await env.CSV_KV.put(K_FILE + id, bytes, { metadata: meta });
  await env.CSV_KV.delete(K_TRASH + id);
  return fromMeta(id, meta);
}

export async function purgeTrash(env, id) {
  // 连历史版本一起清掉
  const versions = await listVersions(env, id);
  for (const v of versions) await env.CSV_KV.delete(v.key);
  await env.CSV_KV.delete(K_TRASH + id);
  return { id };
}

export async function restoreVersion(env, id, seq) {
  const cur = await getFile(env, id);
  if (!cur) throw new HttpError(404, "not_found", "文件不存在");
  const ver = await getVersion(env, id, seq);
  if (!ver) throw new HttpError(404, "version_not_found", "该版本不存在");

  const digest = await sha256Hex(ver.bytes);
  if (digest === cur.meta.sha256) {
    return { action: "unchanged", file: cur.meta };
  }
  // 回滚本身也可回滚：先把当前内容存为新版本
  const latest = (await listVersions(env, id)).reduce((m, v) => Math.max(m, v.seq), 0) + 1;
  await env.CSV_KV.put(`${K_VER}${id}:${pad(latest)}`, cur.bytes, {
    metadata: {
      n: cur.meta.name,
      z: cur.bytes.byteLength,
      h: cur.meta.sha256,
      c: cur.meta.created,
      u: Date.now(),
      o: `回滚到 v${seq} 前的自动存档`,
    },
  });
  await pruneVersions(env, id);

  const meta = {
    ...cur.meta,
    size: ver.bytes.byteLength,
    sha256: digest,
    updated: Date.now(),
    preview: peekText(ver.bytes),
  };
  assertMetaFits(toMeta(meta));
  await env.CSV_KV.put(K_FILE + id, ver.bytes, { metadata: toMeta(meta) });
  return { action: "restored", file: { ...meta, id } };
}

// ---------------- 统计

export async function getStats(env) {
  const [files, trash] = await Promise.all([listFiles(env), listTrash(env)]);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const trashBytes = trash.reduce((s, f) => s + f.size, 0);
  const tags = new Map();
  for (const f of files) for (const t of f.tags) tags.set(t, (tags.get(t) || 0) + 1);
  return {
    fileCount: files.length,
    totalBytes,
    trashCount: trash.length,
    trashBytes,
    tags: [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    lastUpdated: files.reduce((m, f) => Math.max(m, f.updated), 0),
    // 免费版存储 1 GB，给出占用比方便判断是否需要清理
    quotaBytes: 1024 * 1024 * 1024,
  };
}
