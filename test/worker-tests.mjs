// Cloudflare Workers（Static Assets）入口的测试。
// 验证：/api/* 交给 router、其余请求回落到 ASSETS、缺绑定时不崩。

import { suite, test, assert } from "./harness.mjs";
import { createKv, createEnv } from "./mock-kv.mjs";
import worker from "../src/index.js";

/** 造一个带 ASSETS 绑定的 env，记录静态请求被转发了哪些路径 */
function makeEnv({ kv = true, password = "test-password" } = {}) {
  const env = createEnv({ password });
  if (!kv) delete env.CSV_KV;

  env._assetHits = [];
  env.ASSETS = {
    async fetch(request) {
      const url = typeof request === "string" ? new URL(request) : new URL(request.url);
      env._assetHits.push(url.pathname);
      return new Response(`asset:${url.pathname}`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  };
  return env;
}

const req = (path, init = {}) => new Request(`https://example.com${path}`, init);
const run = (w, r, env) => w.fetch(r, env, { waitUntil() {}, passThroughOnException() {} });

async function json(res) {
  try { return await res.json(); } catch { return null; }
}

// ============================================================
suite("Workers 入口：静态与 API 分流");

test("根路径交给静态资产，不经过 API 路由", async () => {
  const env = makeEnv();
  const res = await run(worker, req("/"), env);
  const text = await res.text();
  assert.eq(text, "asset:/");
  assert.eq(env._assetHits, ["/"]);
});

test("样式表等静态文件同样走 ASSETS", async () => {
  const env = makeEnv();
  const res = await run(worker, req("/style.css"), env);
  assert.eq(await res.text(), "asset:/style.css");
});

test("/api/health 交给 router，且返回正常 JSON", async () => {
  const env = makeEnv();
  const res = await run(worker, req("/api/health"), env);
  const body = await json(res);
  assert.eq(res.status, 200);
  assert.eq(body.ok, true);
  assert.eq(body.ready, true);
  assert.eq(env._assetHits.length, 0, "API 请求不该碰到 ASSETS");
});

test("/api 与 /api/xxx 都算 API 路径", async () => {
  const env = makeEnv();
  await run(worker, req("/api"), env);
  await run(worker, req("/api/files"), env);
  assert.eq(env._assetHits.length, 0);
});

test("/apixxx 不是 API 路径，应走静态资产", async () => {
  const env = makeEnv();
  await run(worker, req("/apixxx"), env);
  assert.eq(env._assetHits, ["/apixxx"]);
});

// ============================================================
suite("Workers 入口：端到端");

test("上传 → 列表 → 下载，全程走 Workers 入口", async () => {
  const env = makeEnv();
  const CSV = "物料,数量\n螺丝,100\n";

  const login = await run(
    worker,
    req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    }),
    env
  );
  assert.eq(login.status, 200);
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.startsWith("cbk_session="));

  const up = await run(
    worker,
    req("/api/files?name=%E5%BA%93%E5%AD%98.csv", {
      method: "POST",
      headers: { "content-type": "text/csv", cookie, origin: "https://example.com" },
      body: new TextEncoder().encode(CSV),
    }),
    env
  );
  assert.eq(up.status, 200);
  const id = (await json(up)).results[0].file.id;

  const list = await run(worker, req("/api/files", { headers: { cookie } }), env);
  assert.eq((await json(list)).files.length, 1);

  const dl = await run(worker, req(`/api/files/${id}/download`, { headers: { cookie } }), env);
  assert.eq(await dl.text(), CSV);
});

test("未登录访问 API 返回 401，而不是落到静态页", async () => {
  const env = makeEnv();
  const res = await run(worker, req("/api/files"), env);
  assert.eq(res.status, 401);
  assert.eq(env._assetHits.length, 0);
});

test("没绑 KV 时 /api/health 返回 200 + ready:false（前端靠它渲染自检）", async () => {
  const env = makeEnv({ kv: false });
  const res = await run(worker, req("/api/health"), env);
  const body = await json(res);
  assert.eq(res.status, 200);
  assert.eq(body.ready, false);
  assert.eq(body.missing.some((m) => m.key === "CSV_KV"), true);
});

test("没绑 KV 时数据接口 503 且带补配指引", async () => {
  const env = makeEnv({ kv: false });
  const res = await run(worker, req("/api/files"), env);
  const body = await json(res);
  assert.eq(res.status, 503);
  assert.eq(body.code, "no_kv");
});

test("KV 绑定名是 csv_kv 时也能认出来", async () => {
  const env = makeEnv();
  delete env.CSV_KV;
  env.csv_kv = createKv();
  const res = await run(worker, req("/api/health"), env);
  const body = await json(res);
  assert.eq(body.ready, true);
  assert.eq(body.binding, "csv_kv");
});

test("ASSETS 不可用时给可读错误，不是空白 500", async () => {
  const env = makeEnv();
  delete env.ASSETS;
  const res = await run(worker, req("/index.html"), env);
  assert.eq(res.status, 500);
  const text = await res.text();
  assert.ok(text.includes("ASSETS"), `应提示 ASSETS 绑定问题，实际：${text}`);
});

test("OPTIONS 预检不碰静态资产", async () => {
  const env = makeEnv();
  const res = await run(worker, req("/api/files", { method: "OPTIONS" }), env);
  assert.eq(res.status, 204);
  assert.eq(env._assetHits.length, 0);
});
