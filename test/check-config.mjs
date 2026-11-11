#!/usr/bin/env node
// 校验 wrangler.jsonc 的配置：JSON 结构合法、关键字段齐全、没有留占位符。
//
//   node test/check-config.mjs
//
// 这个检查是为了让「部署前忘记填 KV id」这类问题在推代码时就暴露，
// 而不是等 Cloudflare 构建失败才看到。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(root, "wrangler.jsonc");

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch {
  console.error("✗ 找不到 wrangler.jsonc");
  process.exit(1);
}

// 去掉 // 行注释（但不碰字符串里的 //），再去掉尾逗号，得到可解析的 JSON
function stripJsonc(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

let cfg;
try {
  cfg = JSON.parse(stripJsonc(raw));
} catch (err) {
  console.error(`✗ wrangler.jsonc 不是合法 JSON(C)：${err.message}`);
  process.exit(1);
}

const problems = [];
const notes = [];

// main 必须存在且文件真实存在，否则会退化成「只有静态资产的 Worker」
if (!cfg.main) {
  problems.push("缺少 main —— 没有脚本入口的 Worker 会被判成静态资产，面板将禁用变量与绑定");
} else if (!existsSync(resolve(root, cfg.main))) {
  problems.push(`main 指向的 ${cfg.main} 不存在`);
}

// Worker 名称只允许字母数字和短横线
if (!cfg.name) problems.push("缺少 name");
else if (!/^[a-z0-9-]+$/i.test(cfg.name)) {
  problems.push(`name "${cfg.name}" 只能包含字母、数字和短横线（不能有下划线）`);
}

if (!cfg.compatibility_date) problems.push("缺少 compatibility_date");

// 静态资产目录
const dir = cfg.assets?.directory;
if (!dir) problems.push("缺少 assets.directory");
else if (!existsSync(resolve(root, dir))) problems.push(`assets.directory "${dir}" 目录不存在`);
else if (!existsSync(resolve(root, dir, "index.html"))) {
  problems.push(`assets.directory "${dir}" 里没有 index.html`);
}
if (cfg.assets && !cfg.assets.binding) {
  notes.push("assets.binding 没设：Worker 里就不能用 env.ASSETS 回落静态资源");
}

// KV 绑定
const kvs = cfg.kv_namespaces || [];
const kv = kvs.find((k) => k.binding === "CSV_KV");
if (!kv) {
  problems.push('没有 binding 为 "CSV_KV" 的 kv_namespaces 条目');
} else if (!kv.id || /REPLACE|YOUR|<.*>/i.test(kv.id)) {
  problems.push(
    `CSV_KV 的 id 还是占位符（${kv.id || "空"}）。去 Dashboard → Storage & Databases → KV 建一个命名空间，把 ID 填进来`
  );
}

// run_worker_first 应包含 /api/*
const rwf = cfg.assets?.run_worker_first;
if (!Array.isArray(rwf) || !rwf.some((p) => String(p).startsWith("/api"))) {
  notes.push("run_worker_first 没有覆盖 /api/*：API 请求可能被静态资产截走");
}

// Pages 形态的入口也一起确认
if (!existsSync(resolve(root, "functions", "api", "[[path]].js"))) {
  notes.push("functions/api/[[path]].js 不存在（只有用 Pages 部署时才需要）");
}

console.log(`\n  检查 ${file}\n`);
for (const n of notes) console.log(`  · ${n}`);

if (problems.length) {
  for (const p of problems) console.log(`  \x1b[31m✗\x1b[0m ${p}`);
  console.log(`\n  \x1b[31m${problems.length} 个问题需要修复\x1b[0m\n`);
  process.exitCode = 1;
} else {
  console.log(`  \x1b[32m✓\x1b[0m 配置可用：name=${cfg.name}, main=${cfg.main}, assets=${dir}, KV=CSV_KV`);
  console.log(`\n`);
}
