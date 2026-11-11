// 路由与处理器。
// 一个 catch-all 函数（functions/api/[[path]].js）把所有 /api/* 交给这里，
// 比一堆文件更好控制鉴权顺序，也少踩文件路由的坑。

import { LIMITS, COOKIE_NAME, configStatus, presentVars } from "./config.js";
import {
  HttpError,
  json,
  fail,
  contentDisposition,
  readBytes,
  formatBytes,
} from "./http.js";
import {
  requireAuth,
  verifyPassword,
  verifySession,
  createSession,
  sessionCookie,
  clearSessionCookie,
  readCookie,
  noteLoginFailure,
  clearLoginFailures,
  loginFailureCount,
} from "./auth.js";
import * as store from "./store.js";
import { makeZip } from "./zip.js";

const PUBLIC_MUTATION = new Set(["POST /login"]);

/** 主入口：把异常统一转成 JSON，避免把堆栈暴露给前端 */
export async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = request.method.toUpperCase();
  const route = `${method} /${path.replace(/\/+$/, "")}`;

  const status = configStatus(env);

  // 自检接口永远可用：前端靠它渲染「还差几步」的面板，缺绑定也能问出来
  if (route === "GET /health") {
    return json({
      ok: true,
      name: "csv-kv-backup",
      time: Date.now(),
      ready: status.ready,
      kv: Boolean(status.kv),
      binding: status.binding || null,
      vars: presentVars(env),
      missing: status.missing,
    });
  }

  // 缺 KV 时给出明确、可照着做的提示，而不是 500
  if (!status.kv) {
    return fail(
      503,
      "no_kv",
      "未绑定 KV 命名空间。请在 Cloudflare Pages 项目的设置里绑定一个 KV，变量名填 CSV_KV。",
      { setup: true, missing: status.missing }
    );
  }

  // 绑定名可能不是字面的 CSV_KV（Dashboard 里手打的大小写差异），统一交给后续逻辑
  const runEnv = status.kv === env.CSV_KV ? env : { ...env, CSV_KV: status.kv };

  try {
    if (method === "OPTIONS") return corsPreflight(runEnv);

    // ---------- 无需登录
    if (route === "GET /") {
      return json({ ok: true, name: "csv-kv-backup", time: Date.now() });
    }
    if (route === "GET /me") {
      const cookie = readCookie(request, COOKIE_NAME);
      const authed = cookie ? await verifySession(runEnv, cookie) : false;
      return withCors(
        json({
          ok: true,
          authed,
          hasPassword: Boolean(runEnv.ACCESS_PASSWORD),
          hasToken: Boolean(runEnv.API_TOKEN),
        }),
        runEnv
      );
    }
    if (route === "POST /login") {
      return withCors(await login(request, runEnv, context), runEnv);
    }
    if (route === "POST /logout") {
      return withCors(
        json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } }),
        runEnv
      );
    }

    // ---------- 需要登录
    if (!PUBLIC_MUTATION.has(route)) {
      await requireAuth(request, runEnv);
    }

    return withCors(await dispatch(route, request, runEnv, url), runEnv);
  } catch (err) {
    if (err instanceof HttpError) {
      const extra = err.code === "not_configured" ? { setup: true, missing: status.missing } : err.extra;
      return withCors(fail(err.status, err.code, err.message, extra), runEnv);
    }
    console.error("unhandled", route, err && err.stack);
    return withCors(fail(500, "internal", "服务器内部错误，请查看 Pages 函数日志"), runEnv);
  }
}

async function dispatch(route, request, env, url) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [head, id, sub, seq] = parts;

  if (head === "stats" && !id) return json({ ok: true, ...(await store.getStats(env)) });

  if (head === "files") {
    if (!id) {
      if (route === "GET /files") {
        const files = await store.listFiles(env);
        return json({ ok: true, files, limits: publicLimits() });
      }
      if (route === "POST /files") return upload(request, env);
    } else if (!sub) {
      if (route === `GET /files/${id}`) return fileDetail(env, id);
      if (route === `PATCH /files/${id}`) return patchFile(request, env, id);
      if (route === `DELETE /files/${id}`) return json({ ok: true, ...(await store.trashFile(env, id)) });
    } else if (sub === "download") {
      if (route === `GET /files/${id}/download`) return download(env, id);
    } else if (sub === "versions") {
      if (!seq && route === `GET /files/${id}/versions`) {
        return json({ ok: true, versions: await store.listVersions(env, id) });
      }
      if (seq && route === `GET /files/${id}/versions/${seq}/download`) {
        return downloadVersion(env, id, seq);
      }
      if (seq && route === `POST /files/${id}/versions/${seq}/restore`) {
        return json({ ok: true, ...(await store.restoreVersion(env, id, Number(seq))) });
      }
    }
  }

  if (head === "trash") {
    if (!id && route === "GET /trash") return json({ ok: true, files: await store.listTrash(env) });
    if (id && route === `DELETE /trash/${id}`) {
      return json({ ok: true, ...(await store.purgeTrash(env, id)) });
    }
    if (id && sub === "restore" && route === `POST /trash/${id}/restore`) {
      return json({ ok: true, file: await store.restoreFromTrash(env, id) });
    }
  }

  if (head === "export" && !id && route === "GET /export") return exportZip(env);

  return fail(404, "no_route", `未知接口：${route}`);
}

function publicLimits() {
  return {
    maxFileBytes: LIMITS.maxFileBytes,
    maxVersions: LIMITS.maxVersions,
    maxZipBytes: LIMITS.maxZipBytes,
    maxTags: LIMITS.maxTags,
  };
}

// ---------------- 登录

async function login(request, env, context) {
  const { configured } = await import("./config.js").then((m) => m.readSecrets(env));
  if (!configured) {
    return fail(503, "not_configured", "服务端未设置 ACCESS_PASSWORD，无法登录");
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const failures = await loginFailureCount(env, ip);
  if (failures >= 10) {
    return fail(429, "too_many_attempts", "密码错误次数过多，请 15 分钟后再试");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "bad_json", "请求体必须是 JSON");
  }
  const password = String(body?.password || "").slice(0, 512);
  if (!(await verifyPassword(env, password))) {
    await noteLoginFailure(env, ip);
    return fail(401, "bad_password", `密码不正确（还可尝试 ${Math.max(0, 9 - failures)} 次）`);
  }

  await clearLoginFailures(env, ip);
  const token = await createSession(env);
  return json({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

// ---------------- 上传

/**
 * 支持两种提交方式：
 *   1) multipart/form-data，字段名 file（可多个）+ name/tags/sameName
 *   2) 原始字节流，用 ?name=xx.csv 指定文件名（脚本/curl 友好）
 */
async function upload(request, env) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  const results = [];

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const sameName = String(form.get("sameName") ?? "true") !== "false";
    const tags = store.normalizeTags(form.get("tags") || []);
    const entries = form.getAll("file").filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
    if (!entries.length) throw new HttpError(400, "no_file", "没有收到文件");
    for (const file of entries) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > LIMITS.maxFileBytes) {
        throw new HttpError(413, "too_large", `${file.name} 超过上限（${formatBytes(LIMITS.maxFileBytes)}）`);
      }
      results.push(
        await store.saveFile(env, {
          name: form.get("name") || file.name,
          bytes,
          tags,
          sameName,
          note: "网页上传",
        })
      );
    }
  } else {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") || request.headers.get("x-filename") || "";
    if (!name) throw new HttpError(400, "no_name", "缺少文件名：请用 ?name=xxx.csv 或 X-Filename 头");
    const bytes = await readBytes(request, LIMITS.maxFileBytes);
    if (!bytes.byteLength) throw new HttpError(400, "empty", "文件是空的");
    results.push(
      await store.saveFile(env, {
        name,
        bytes,
        tags: store.normalizeTags(url.searchParams.get("tags") || ""),
        sameName: url.searchParams.get("sameName") !== "false",
        note: "接口上传",
      })
    );
  }

  return json({ ok: true, results });
}

// ---------------- 读取 / 修改

async function fileDetail(env, id) {
  const cur = await store.getFileMeta(env, id);
  if (!cur) throw new HttpError(404, "not_found", "文件不存在");
  const versions = await store.listVersions(env, id);
  return json({ ok: true, file: cur, versions });
}

async function patchFile(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "bad_json", "请求体必须是 JSON");
  }
  const file = await store.updateFileMeta(env, id, {
    name: body?.name != null ? String(body.name) : null,
    tags: body?.tags != null ? body.tags : null,
  });
  return json({ ok: true, file });
}

async function download(env, id) {
  const cur = await store.getFile(env, id);
  if (!cur) throw new HttpError(404, "not_found", "文件不存在");
  return new Response(cur.bytes, {
    headers: {
      "content-type": mimeOf(cur.meta.name),
      "content-disposition": contentDisposition(cur.meta.name.split("/").pop()),
      "content-length": String(cur.bytes.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function downloadVersion(env, id, seq) {
  const ver = await store.getVersion(env, id, Number(seq));
  if (!ver) throw new HttpError(404, "version_not_found", "该版本不存在");
  const base = ver.meta.name.split("/").pop().replace(/\.(\w+)$/, "");
  const ext = (ver.meta.name.match(/\.(\w+)$/) || [".csv"])[0];
  const name = `${base}-v${seq}${ext}`;
  return new Response(ver.bytes, {
    headers: {
      "content-type": mimeOf(ver.meta.name),
      "content-disposition": contentDisposition(name),
      "content-length": String(ver.bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}

function mimeOf(name) {
  const ext = store.extensionOf(name);
  const map = {
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    json: "application/json; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    log: "text/plain; charset=utf-8",
    ndjson: "application/x-ndjson; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

// ---------------- 打包导出

async function exportZip(env) {
  const files = await store.listFiles(env);
  if (!files.length) throw new HttpError(404, "empty", "还没有任何备份");
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > LIMITS.maxZipBytes) {
    throw new HttpError(
      413,
      "zip_too_large",
      `全部文件合计 ${formatBytes(total)}，超过打包上限 ${formatBytes(LIMITS.maxZipBytes)}，请分批下载`
    );
  }

  const entries = [];
  for (const f of files) {
    const cur = await store.getFile(env, f.id);
    if (!cur) continue;
    entries.push({ name: f.name, bytes: cur.bytes, date: f.updated });
  }
  // 附带一份清单，便于核对与迁移
  const manifest = {
    exportedAt: new Date().toISOString(),
    count: entries.length,
    totalBytes: entries.reduce((s, e) => s + e.bytes.byteLength, 0),
    files: entries.map((e) => ({
      name: e.name,
      bytes: e.bytes.byteLength,
      updated: new Date(e.date).toISOString(),
    })),
  };
  entries.unshift({
    name: "_manifest.json",
    bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    date: Date.now(),
  });

  const zip = await makeZip(entries);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(`csv-backup-${stamp}.zip`),
      "content-length": String(zip.byteLength),
      "cache-control": "no-store",
    },
  });
}

// ---------------- CORS

/**
 * 只对带 Authorization 的脚本调用放开 CORS；
 * 浏览器带 cookie 的请求不需要（也不应该）跨域。
 */
function withCors(response, env) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}

function corsPreflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-filename",
      "access-control-max-age": "86400",
    },
  });
}
