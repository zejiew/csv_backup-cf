// 端到端自测：用内存 KV 模拟真实 KV 的行为，直接打 router 的 handle()。
// 跑法：node test/run-tests.mjs

import { suite, test, assert, run } from "./harness.mjs";
import { createKv, createEnv, ctx } from "./mock-kv.mjs";
import { handle } from "../functions/_lib/router.js";

// 只做注册，不自行 run()——最后的 run() 由本文件统一调用
import "./worker-tests.mjs";

const CSV = "名称,数量,单价\n焊条,320,12.5\n砂纸,150,3.2\n";
const CSV2 = "名称,数量,单价\n焊条,300,12.5\n砂纸,160,3.2\n";

const enc = (s) => new TextEncoder().encode(s);

/** 发一个请求并把 JSON 解出来 */
async function call(env, path, init = {}) {
  const res = await handle(ctx(env, path, init));
  let body = null;
  try { body = await res.json(); } catch { /* 可能是二进制 */ }
  return { res, body };
}

async function login(env, password = "test-password") {
  const { res, body } = await call(env, "/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ password }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  return { res, body, cookie };
}

function uploadRaw(env, cookie, name, text, extra = {}) {
  return call(env, `/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      cookie,
      origin: "https://example.com",
      ...extra,
    },
    body: enc(text),
  });
}

// ============================================================
suite("基础 / 健康检查");

test("未绑定 KV 时数据接口返回 503，并带上补配指引", async () => {
  const env = { ACCESS_PASSWORD: "x" };
  const { res, body } = await call(env, "/files");
  assert.eq(res.status, 503);
  assert.eq(body.code, "no_kv");
  assert.ok(body.missing.some((m) => m.key === "CSV_KV"));
});

test("未绑定时 /health 仍可用，用来渲染「还差几步」面板", async () => {
  const env = { ACCESS_PASSWORD: "x" };
  const { res, body } = await call(env, "/health");
  assert.eq(res.status, 200);
  assert.eq(body.ready, false);
  assert.eq(body.kv, false);
  assert.ok(body.missing.some((m) => m.key === "CSV_KV"));
  assert.eq(body.vars.includes("ACCESS_PASSWORD"), true);
});

test("KV 绑定名写成 csv_kv 也能认出来", async () => {
  const env = { ACCESS_PASSWORD: "x", csv_kv: createKv() };
  const { res, body } = await call(env, "/health");
  assert.eq(res.status, 200);
  assert.eq(body.ready, true);
  assert.eq(body.binding, "csv_kv");
});

test("GET /health 不需要登录", async () => {
  const env = createEnv();
  const { res, body } = await call(env, "/health");
  assert.eq(res.status, 200);
  assert.ok(body.ok === true);
});

test("没有配置任何凭据时拒绝服务（不裸奔）", async () => {
  const env = createEnv({ password: "" });
  const { res, body } = await call(env, "/files");
  assert.eq(res.status, 503);
  assert.eq(body.code, "not_configured");
});

// ============================================================
suite("登录与会话");

test("密码正确时下发会话 cookie", async () => {
  const env = createEnv();
  const { res, cookie } = await login(env);
  assert.eq(res.status, 200);
  assert.ok(cookie.startsWith("cbk_session="), "cookie 名称应为 cbk_session");
  const sc = res.headers.get("set-cookie");
  assert.ok(sc.includes("HttpOnly"), "必须 HttpOnly");
  assert.ok(sc.includes("Secure"), "必须 Secure");
  assert.ok(sc.includes("SameSite=Lax"), "必须 SameSite=Lax");
});

test("密码错误返回 401，且提示剩余次数", async () => {
  const env = createEnv();
  const { res, body } = await call(env, "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.eq(res.status, 401);
  assert.eq(body.code, "bad_password");
  assert.ok(/还可尝试/.test(body.message), "应提示剩余次数");
});

test("连续失败 10 次后被节流", async () => {
  const env = createEnv();
  for (let i = 0; i < 10; i++) {
    await call(env, "/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ password: "wrong" }),
    });
  }
  const { res, body } = await call(env, "/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
    body: JSON.stringify({ password: "test-password" }),
  });
  assert.eq(res.status, 429);
  assert.eq(body.code, "too_many_attempts");
});

test("没 cookie 访问受保护接口返回 401", async () => {
  const env = createEnv();
  const { res, body } = await call(env, "/files");
  assert.eq(res.status, 401);
  assert.eq(body.code, "login_required");
});

test("伪造的 cookie 无法通过签名校验", async () => {
  const env = createEnv();
  const forged = "eyJleHAiOjk5OTk5OTk5OTk5OTl9.ZmFrZXNpZw";
  const { res } = await call(env, "/files", { headers: { cookie: `cbk_session=${forged}` } });
  assert.eq(res.status, 401);
});

test("换了 SESSION_SECRET 后旧会话失效", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  env.SESSION_SECRET = "another-secret";
  const { res } = await call(env, "/files", { headers: { cookie } });
  assert.eq(res.status, 401);
});

test("API Token 可直接访问，无需 cookie", async () => {
  const env = createEnv({ apiToken: "tok_abc123" });
  const { res, body } = await call(env, "/files", {
    headers: { authorization: "Bearer tok_abc123" },
  });
  assert.eq(res.status, 200);
  assert.eq(body.files, []);
});

test("错误的 API Token 返回 401", async () => {
  const env = createEnv({ apiToken: "tok_abc123" });
  const { res, body } = await call(env, "/files", {
    headers: { authorization: "Bearer nope" },
  });
  assert.eq(res.status, 401);
  assert.eq(body.code, "bad_token");
});

test("跨站 Origin 的写操作被拒（CSRF）", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const { res, body } = await call(env, "/files?name=a.csv", {
    method: "POST",
    headers: { "content-type": "text/csv", cookie, origin: "https://evil.example" },
    body: enc(CSV),
  });
  assert.eq(res.status, 403);
  assert.eq(body.code, "bad_origin");
});

// ============================================================
suite("上传与列表");

test("上传一个 CSV 后能在列表里看到", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  assert.eq(up.res.status, 200);
  assert.eq(up.body.results[0].action, "created");

  const { body } = await call(env, "/files", { headers: { cookie } });
  assert.eq(body.files.length, 1);
  assert.eq(body.files[0].name, "库存表.csv");
  assert.ok(body.files[0].size > 0);
  assert.ok(body.files[0].preview.includes("焊条"), "列表应带内容预览");
});

test("预览里的 BOM 被剥掉", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  await uploadRaw(env, cookie, "带bom.csv", "\uFEFF名称,数量\nA,1\n");
  const { body } = await call(env, "/files", { headers: { cookie } });
  assert.ok(!body.files[0].preview.startsWith("\uFEFF"), "预览不应以 BOM 开头");
});

test("同名文件再传一次 → 旧内容进版本，不算新文件", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  await uploadRaw(env, cookie, "库存表.csv", CSV);
  const up2 = await uploadRaw(env, cookie, "库存表.csv", CSV2);
  assert.eq(up2.body.results[0].action, "versioned");

  const { body } = await call(env, "/files", { headers: { cookie } });
  assert.eq(body.files.length, 1, "仍然只有一个文件");
  assert.eq(body.files[0].versionCount, 1, "应记录 1 个历史版本");
});

test("内容完全相同的重复上传 → unchanged，不写 KV", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  await uploadRaw(env, cookie, "库存表.csv", CSV);
  const kv = env.CSV_KV;
  kv._resetStats();
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  assert.eq(up.body.results[0].action, "unchanged");
  assert.eq(kv.stats.puts, 0, "内容没变就不该产生写操作");
});

test("?sameName=false 时重名文件自动加序号", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  await uploadRaw(env, cookie, "库存表.csv", CSV);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV2 + "\n#v2");
  // 上面这条用了 sameName 默认 true，这里再显式测 false
  const up2 = await call(env, `/files?name=${encodeURIComponent("库存表.csv")}&sameName=false`, {
    method: "POST",
    headers: { "content-type": "text/csv", cookie, origin: "https://example.com" },
    body: enc("别的,内容\n1,2\n"),
  });
  assert.eq(up2.res.status, 200);
  assert.ok(up2.body.results[0].file.name.includes("(2)"), `应重命名，实际 ${up2.body.results[0].file.name}`);
  assert.ok(up.body.results[0].action === "versioned");
});

test("超过上限的文件被 413 拒绝", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const big = new Uint8Array(21 * 1024 * 1024);
  const { res, body } = await call(env, "/files?name=big.csv", {
    method: "POST",
    headers: { "content-type": "text/csv", cookie, origin: "https://example.com" },
    body: big,
  });
  assert.eq(res.status, 413);
  assert.eq(body.code, "too_large");
});

test("没给文件名时返回 400 并提示用法", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const { res, body } = await call(env, "/files", {
    method: "POST",
    headers: { "content-type": "text/csv", cookie, origin: "https://example.com" },
    body: enc(CSV),
  });
  assert.eq(res.status, 400);
  assert.eq(body.code, "no_name");
});

test("路径穿越的文件名被规范化，不会逃出目录", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "../../etc/passwd.csv", CSV);
  const name = up.body.results[0].file.name;
  assert.ok(!name.includes(".."), `不应含 ..：${name}`);
  const { body } = await call(env, "/files", { headers: { cookie } });
  assert.eq(body.files[0].name, name);
});

test("中文文件名能正常往返（含标点）", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const name = "2026年3月 物料台账（终版）.csv";
  const up = await uploadRaw(env, cookie, name, CSV);
  assert.eq(up.body.results[0].file.name, name);
});

test("multipart 一次上传多个文件", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const form = new FormData();
  form.append("file", new File([CSV], "a.csv", { type: "text/csv" }));
  form.append("file", new File([CSV2], "b.csv", { type: "text/csv" }));
  const { res, body } = await call(env, "/files", {
    method: "POST",
    headers: { cookie, origin: "https://example.com" },
    body: form,
  });
  assert.eq(res.status, 200);
  assert.eq(body.results.length, 2);
  const list = await call(env, "/files", { headers: { cookie } });
  assert.eq(list.body.files.length, 2);
});

// ============================================================
suite("下载与版本");

test("下载内容与上传字节一致", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  const id = up.body.results[0].file.id;
  const res = await handle(ctx(env, `/files/${id}/download`, { headers: { cookie } }));
  assert.eq(res.status, 200);
  const text = await res.text();
  assert.eq(text, CSV);
  assert.ok((res.headers.get("content-disposition") || "").includes("attachment"));
});

test("中文文件名在 Content-Disposition 里走 RFC 5987", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  const id = up.body.results[0].file.id;
  const res = await handle(ctx(env, `/files/${id}/download`, { headers: { cookie } }));
  const cd = res.headers.get("content-disposition");
  assert.ok(cd.includes("filename*=UTF-8''"), `应带 filename*，实际：${cd}`);
});

test("历史版本可列出、可下载、可回滚", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  const id = up.body.results[0].file.id;
  await uploadRaw(env, cookie, "库存表.csv", CSV2);

  const vs = await call(env, `/files/${id}/versions`, { headers: { cookie } });
  assert.eq(vs.body.versions.length, 1);
  const seq = vs.body.versions[0].seq;

  // 下载旧版，内容应是 CSV（第一版）
  const dl = await handle(ctx(env, `/files/${id}/versions/${seq}/download`, { headers: { cookie } }));
  assert.eq(await dl.text(), CSV);

  // 回滚
  const rb = await call(env, `/files/${id}/versions/${seq}/restore`, {
    method: "POST",
    headers: { cookie, origin: "https://example.com" },
    body: "{}",
  });
  assert.eq(rb.body.action, "restored");

  const now = await handle(ctx(env, `/files/${id}/download`, { headers: { cookie } }));
  assert.eq(await now.text(), CSV, "回滚后内容应是旧版");

  // 回滚前的内容也被存成了版本 → 回滚本身可撤回
  const vs2 = await call(env, `/files/${id}/versions`, { headers: { cookie } });
  assert.eq(vs2.body.versions.length, 2, "回滚前应自动存档一份");
});

test("历史版本超过 10 份时淘汰最旧的", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "多次.csv", "v0\n");
  const id = up.body.results[0].file.id;
  for (let i = 1; i <= 13; i++) {
    await uploadRaw(env, cookie, "多次.csv", `v${i}\n`);
  }
  const vs = await call(env, `/files/${id}/versions`, { headers: { cookie } });
  assert.eq(vs.body.versions.length, 10, `应只留 10 份，实际 ${vs.body.versions.length}`);
  const seqs = vs.body.versions.map((v) => v.seq).sort((a, b) => a - b);
  assert.eq(seqs[seqs.length - 1], 13, "最新的版本应保留");
});

test("不存在的 id 返回 404", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const { res, body } = await call(env, "/files/nosuchid/download", { headers: { cookie } });
  assert.eq(res.status, 404);
  assert.eq(body.code, "not_found");
});

// ============================================================
suite("改名 / 标签 / 回收站");

test("PATCH 可以改名和改标签", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "旧名.csv", CSV);
  const id = up.body.results[0].file.id;
  const { body } = await call(env, `/files/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: "https://example.com" },
    body: JSON.stringify({ name: "新名.csv", tags: ["物料", "2026-03"] }),
  });
  assert.eq(body.file.name, "新名.csv");
  assert.eq(body.file.tags, ["物料", "2026-03"]);

  // 内容不该被改名影响
  const dl = await handle(ctx(env, `/files/${id}/download`, { headers: { cookie } }));
  assert.eq(await dl.text(), CSV);
});

test("标签去重、截断、限 8 个", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "t.csv", CSV);
  const id = up.body.results[0].file.id;
  const many = ["a", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const { body } = await call(env, `/files/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: "https://example.com" },
    body: JSON.stringify({ tags: many }),
  });
  assert.eq(body.file.tags.length, 8, "最多 8 个标签");
  assert.eq(body.file.tags[0], "a");
  assert.ok(!body.file.tags.includes("a", 1), "标签应去重");
});

test("删除进回收站 → 还原 → 内容还在", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  const id = up.body.results[0].file.id;

  await call(env, `/files/${id}`, { method: "DELETE", headers: { cookie, origin: "https://example.com" } });
  let list = await call(env, "/files", { headers: { cookie } });
  assert.eq(list.body.files.length, 0, "列表里不该再有");

  const trash = await call(env, "/trash", { headers: { cookie } });
  assert.eq(trash.body.files.length, 1);

  await call(env, `/trash/${id}/restore`, {
    method: "POST", headers: { cookie, origin: "https://example.com" }, body: "{}",
  });
  list = await call(env, "/files", { headers: { cookie } });
  assert.eq(list.body.files.length, 1);

  const dl = await handle(ctx(env, `/files/${id}/download`, { headers: { cookie } }));
  assert.eq(await dl.text(), CSV, "还原后内容应完好");
});

test("彻底删除会连历史版本一起清掉", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "库存表.csv", CSV);
  const id = up.body.results[0].file.id;
  await uploadRaw(env, cookie, "库存表.csv", CSV2);
  await call(env, `/files/${id}`, { method: "DELETE", headers: { cookie, origin: "https://example.com" } });
  await call(env, `/trash/${id}`, { method: "DELETE", headers: { cookie, origin: "https://example.com" } });

  const keys = env.CSV_KV._dump().map((k) => k.key);
  assert.ok(!keys.some((k) => k.includes(id)), `不该留下 ${id} 相关 key：${keys.join(",")}`);
});

// ============================================================
suite("统计与导出");

test("stats 汇总文件数、占用、标签", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "a.csv", CSV);
  await call(env, `/files/${up.body.results[0].file.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: "https://example.com" },
    body: JSON.stringify({ tags: ["物料"] }),
  });
  const { body } = await call(env, "/stats", { headers: { cookie } });
  assert.eq(body.fileCount, 1);
  assert.ok(body.totalBytes > 0);
  assert.eq(body.quotaBytes, 1024 * 1024 * 1024);
  assert.eq(body.tags[0].name, "物料");
});

test("整包导出是合法 zip（PK 头 + 含 manifest）", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  await uploadRaw(env, cookie, "a.csv", CSV);
  await uploadRaw(env, cookie, "b.csv", CSV2);
  const res = await handle(ctx(env, "/export", { headers: { cookie } }));
  assert.eq(res.status, 200);
  assert.eq(res.headers.get("content-type"), "application/zip");
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.eq([buf[0], buf[1]], [0x50, 0x4b], "应以 PK\\x03\\x04 开头");
  const text = new TextDecoder("latin1").decode(buf);
  assert.ok(text.includes("_manifest.json"), "应包含 manifest");
  assert.ok(text.includes("a.csv"), "应包含 a.csv");
});

test("列表只花 1 次 KV list，不做 N+1 次 get", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  for (let i = 0; i < 8; i++) await uploadRaw(env, cookie, `f${i}.csv`, `x\n${i}\n`);
  const kv = env.CSV_KV;
  kv._resetStats();
  const { body } = await call(env, "/files", { headers: { cookie } });
  assert.eq(body.files.length, 8);
  assert.eq(kv.stats.gets, 0, `列表不该产生 get，实际 ${kv.stats.gets} 次`);
  assert.ok(kv.stats.lists >= 1, "应该走 list");
});

// ============================================================
suite("边界 / 防御");

test("metadata 超 1024B 时给出可读错误而不是 500", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  // 超长文件名 + 超长预览 + 8 个长标签，逼到 metadata 上限
  const up = await uploadRaw(env, cookie, "长".repeat(200) + ".csv", CSV);
  const id = up.body.results[0].file.id;
  const { res, body } = await call(env, `/files/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: "https://example.com" },
    body: JSON.stringify({ tags: Array.from({ length: 8 }, (_, i) => "标".repeat(24) + i) }),
  });
  // 超了就应该是 400 + 明确 code，不能崩成 500
  if (res.status === 400) {
    assert.eq(body.code, "meta_too_large");
  } else {
    assert.eq(res.status, 200, "没超限就该成功");
  }
});

test("二进制文件不产生乱码预览", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03]);
  const up = await call(env, "/files?name=bin.csv", {
    method: "POST",
    headers: { "content-type": "text/csv", cookie, origin: "https://example.com" },
    body: bytes,
  });
  assert.eq(up.body.results[0].file.preview, "", "二进制不该有预览");
});

test("未知路由返回 404 JSON 而不是 HTML", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const { res, body } = await call(env, "/nope", { headers: { cookie } });
  assert.eq(res.status, 404);
  assert.eq(body.code, "no_route");
});

test("list 跟随 cursor（用很小的分页逼出翻页）", async () => {
  // 用 pageSize=7 的 mock，50 个 key 就要翻 8 页；走的是真实的 listFiles 路径
  const { listFiles } = await import("../functions/_lib/store.js");
  const { createKv: mk, createEnv: mkEnv } = await import("./mock-kv.mjs");
  const kv = mk({ pageSize: 7 });
  for (let i = 0; i < 50; i++) {
    await kv.put(`f:${String(i).padStart(3, "0")}`, "x", {
      metadata: { n: `f${i}.csv`, z: 1, h: "h", c: 1, u: i, v: 0, g: [], p: "" },
    });
  }
  const env = mkEnv({ kv });
  const files = await listFiles(env);
  assert.eq(files.length, 50, `应拿到全部 50 条，实际 ${files.length}`);
  assert.ok(kv.stats.lists >= 8, `应该翻了至少 8 页，实际 ${kv.stats.lists}`);
});

test("回收站里的条目不计入列表统计", async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const up = await uploadRaw(env, cookie, "a.csv", CSV);
  const id = up.body.results[0].file.id;
  await call(env, `/files/${id}`, { method: "DELETE", headers: { cookie, origin: "https://example.com" } });
  const { body } = await call(env, "/stats", { headers: { cookie } });
  assert.eq(body.fileCount, 0);
  assert.eq(body.trashCount, 1);
});

await run();
