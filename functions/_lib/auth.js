// 鉴权：密码换会话 cookie（HMAC 签名，无需服务端存储）、API Token（脚本用）。
// 全部基于 WebCrypto，无需依赖。

import { COOKIE_NAME, LIMITS, readSecrets } from "./config.js";
import { HttpError } from "./http.js";

const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad + "===".slice((pad.length + 3) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** 定长比较，避免逐字节比较泄露信息 */
function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 用口令派生一个比较值，避免把明文口令直接放在比较表达式里 */
export async function digest(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(`cbk:v1:${text}`));
  return b64url(buf);
}

export async function createSession(env) {
  const { sessionSecret } = readSecrets(env);
  const exp = Date.now() + LIMITS.sessionDays * 86400_000;
  const payload = b64url(enc.encode(JSON.stringify({ exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(sessionSecret), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(env, cookieValue) {
  if (!cookieValue) return false;
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return false;
  const payload = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  const { sessionSecret } = readSecrets(env);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(sessionSecret),
      fromB64url(sig),
      enc.encode(payload)
    );
  } catch {
    return false;
  }
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

export function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/**
 * 是否为受信任的写操作来源。
 * 会话 cookie 会随跨站请求自动携带，因此状态变更必须校验 Origin，
 * 否则一个恶意页面就能借用户浏览器往备份里塞/删文件。
 */
export function checkOrigin(req, env) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // 非浏览器客户端（curl / 脚本）不带 Origin
  const allowed = [env.PUBLIC_ORIGIN, new URL(req.url).origin].filter(Boolean);
  return allowed.some((a) => {
    try {
      return new URL(a).origin === origin;
    } catch {
      return false;
    }
  });
}

/** 登录失败节流：只在失败时写 KV，正常使用不消耗写额度 */
export async function noteLoginFailure(env, ip) {
  const key = `_sys:fail:${await digest(ip || "unknown")}`;
  const cur = Number((await env.CSV_KV.get(key)) || 0) + 1;
  await env.CSV_KV.put(key, String(cur), { expirationTtl: 900 });
  return cur;
}

export async function clearLoginFailures(env, ip) {
  await env.CSV_KV.delete(`_sys:fail:${await digest(ip || "unknown")}`);
}

export async function loginFailureCount(env, ip) {
  return Number((await env.CSV_KV.get(`_sys:fail:${await digest(ip || "unknown")}`)) || 0);
}

/**
 * 校验一个写请求的凭据。
 * 优先级：API Token（Authorization: Bearer）→ 会话 cookie。
 * 密码登录本身走 /api/login，不经过这里。
 */
export async function requireAuth(req, env) {
  const secrets = readSecrets(env);
  if (!secrets.configured) {
    throw new HttpError(
      503,
      "not_configured",
      "服务端未设置 ACCESS_PASSWORD 或 API_TOKEN，已拒绝服务。请在 Cloudflare Pages 的环境变量里配置。"
    );
  }

  const auth = req.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (secrets.apiToken && (await digest(token)) === (await digest(secrets.apiToken))) {
      return { via: "token" };
    }
    throw new HttpError(401, "bad_token", "API Token 不正确");
  }

  const cookie = readCookie(req, COOKIE_NAME);
  if (!cookie) throw new HttpError(401, "login_required", "请先登录");
  if (!(await verifySession(env, cookie))) {
    throw new HttpError(401, "session_expired", "登录已过期，请重新登录");
  }
  if (!checkOrigin(req, env)) throw new HttpError(403, "bad_origin", "来源不被信任");
  return { via: "session" };
}

export async function verifyPassword(env, input) {
  const { password } = readSecrets(env);
  if (!password) return false;
  return safeEqual(await digest(input), await digest(password));
}

/** 只允许读写指定名字的 cookie，避免会话在别的路径下被复用 */
export function sessionCookie(token) {
  const maxAge = LIMITS.sessionDays * 86400;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
