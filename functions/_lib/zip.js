// 单文件 ZIP 打包器：只用 deflate-raw，不引依赖。
// 打包导出是为了「一键把全部备份下载到本地」，这比逐个点下载实用得多。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  // 空文件或极端小的文件不值得压缩，直接 store
  if (bytes.length < 64) return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null; // 环境不支持时退回 store，不影响可用性
  }
}

const enc = new TextEncoder();

/** 修正 ZIP 的 DOS 时间字段（1980 起算，2 秒精度） */
function dosTime(date) {
  const d = new Date(date || Date.now());
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const y = Math.max(1980, d.getFullYear());
  const day = (((y - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {{name:string, bytes:Uint8Array, date?:number}[]} entries
 * @returns {Promise<Uint8Array>}
 */
export async function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();

  for (const entry of entries) {
    let name = String(entry.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
    name = name.split("/").filter((s) => s && s !== "." && s !== "..").join("/");
    if (!name) continue;
    // 同名条目会让解压结果不可预期，加序号区分
    let finalName = name;
    for (let i = 2; seen.has(finalName); i++) {
      const dot = name.lastIndexOf(".");
      finalName = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    seen.add(finalName);

    const nameBytes = enc.encode(finalName);
    const raw = entry.bytes || new Uint8Array(0);
    const deflated = await deflateRaw(raw);
    const data = deflated || raw;
    const method = deflated ? 8 : 0;
    const crc = crc32(raw);
    const { time, day } = dosTime(entry.date);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
    lv.setUint16(4, 20, true); // 解压所需版本
    lv.setUint16(6, 0x0800, true); // 通用位：UTF-8 文件名
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // 中央目录签名
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true); // 注释长度
    cv.setUint16(34, 0, true); // 磁盘号
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // 中央目录结束签名
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
