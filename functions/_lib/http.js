// HTTP 小工具：统一 JSON 响应、统一错误类型、限长读取请求体。

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

export function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function fail(status, code, message, extra) {
  return json({ ok: false, code, message, ...(extra || {}) }, { status });
}

/** RFC 5987：让中文文件名在 Content-Disposition 里正确落地 */
export function contentDisposition(name, inline = false) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(String(name)).replace(/['()]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 读请求体并限长。先看 Content-Length 快速拒绝，再在读完后复核一次
 * （避免 chunked 上传绕过长度头）。
 */
export async function readBytes(req, maxBytes) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    throw new HttpError(413, "too_large", `文件超过上限（${formatBytes(maxBytes)}）`);
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new HttpError(413, "too_large", `文件超过上限（${formatBytes(maxBytes)}）`);
  }
  return new Uint8Array(buf);
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
