// 全局常量与运行期配置。
// KV 的硬限制（见 README「为什么有这些限制」）：
//   单值 25 MiB、key 512B、metadata 1024B、免费版 1000 次写入/天、同一 key 1 次/秒。
// 这里把单文件上限定在 20 MiB，给 JSON 包装和将来改动留余量。

export const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024, // 单次上传上限
  maxVersions: 10, // 每个文件保留的历史版本数
  maxZipBytes: 64 * 1024 * 1024, // 打包导出上限，超过就提示逐个下载
  maxNameChars: 200, // 文件名展示上限
  maxTags: 8,
  maxTagChars: 24,
  sessionDays: 30,
});

/**
 * 读取部署时配置的凭据。
 * 没有任何凭据时 configured=false，接口会拒绝服务（见 router），避免站点裸奔。
 */
export function readSecrets(env) {
  const password = String(env.ACCESS_PASSWORD || "").trim();
  const apiToken = String(env.API_TOKEN || "").trim();
  const sessionSecret = String(env.SESSION_SECRET || "").trim() || password || apiToken;
  return {
    password,
    apiToken,
    sessionSecret,
    configured: Boolean(password || apiToken),
  };
}

export const COOKIE_NAME = "cbk_session";

/* ---------------- 绑定解析 ---------------- */

const KV_METHODS = ["get", "put", "delete", "list"];

function looksLikeKv(value) {
  return !!value && KV_METHODS.every((m) => typeof value[m] === "function");
}

/** 绑定名的宽松匹配：CSV_KV / csv_kv / csv-kv 都认，避免 Dashboard 里手打差一个符号就报错 */
const normalizeBinding = (name) => String(name).replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * 找出 KV 绑定。
 * 优先 env.CSV_KV；没有就找名字规范化后等于 csvkv 的绑定。
 * **不做泛化的鸭子类型扫描**——R2 桶也有 get/put/delete/list，乱认会写出更难查的错。
 */
export function resolveKv(env) {
  if (looksLikeKv(env?.CSV_KV)) return { kv: env.CSV_KV, binding: "CSV_KV" };
  for (const [name, value] of Object.entries(env || {})) {
    if (name === "CSV_KV") continue;
    if (normalizeBinding(name) === "csvkv" && looksLikeKv(value)) {
      return { kv: value, binding: name };
    }
  }
  return { kv: null, binding: "" };
}

/**
 * 部署自检：缺什么、缺在哪一步、怎么补。
 * 前端拿它渲染「还差两步」的面板，而不是甩一句 503 让人猜。
 */
export function configStatus(env) {
  const { kv, binding } = resolveKv(env);
  const secrets = readSecrets(env);
  const missing = [];

  if (!kv) {
    missing.push({
      key: "CSV_KV",
      kind: "kv",
      label: "KV 命名空间绑定",
      where: "Pages 项目 → Settings → Bindings（旧版在 Functions → KV namespace bindings）",
      hint: "变量名必须填 CSV_KV，值选你创建的那个 KV 命名空间。",
    });
  }
  if (!secrets.configured) {
    missing.push({
      key: "ACCESS_PASSWORD",
      kind: "var",
      label: "访问口令（环境变量）",
      where: "Pages 项目 → Settings → Environment variables",
      hint: "类型选 Secret（加密），值就是你的登录密码；改完要重新部署一次才生效。",
    });
  }

  return { kv, binding, secrets, missing, ready: missing.length === 0 };
}

/** 环境变量里已经有哪些（只报名字，不回显值） */
export function presentVars(env) {
  return ["ACCESS_PASSWORD", "API_TOKEN", "SESSION_SECRET", "PUBLIC_ORIGIN"]
    .filter((k) => String(env?.[k] || "").trim())
    .map((k) => k);
}
