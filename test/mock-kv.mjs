// KV 命名空间的最小可用模拟。
//
// 只实现本项目用到的部分，但**故意保留**真实 KV 的几处坑，好让测试真的能抓到 bug：
//   - list 一次最多 1000 条，必须跟随 cursor
//   - metadata 上限 1024 字节
//   - 值的上限 25 MiB
//   - getWithMetadata 返回 {value, metadata}，value 类型跟随 type

const META_LIMIT = 1024;
const VALUE_LIMIT = 25 * 1024 * 1024;
const LIST_LIMIT = 1000;

export function createKv({ pageSize = LIST_LIMIT } = {}) {
  /** @type {Map<string, {value: Uint8Array, metadata: any, expiresAt: number}>} */
  const map = new Map();
  const stats = { gets: 0, puts: 0, deletes: 0, lists: 0 };

  const now = () => Date.now();

  function alive(entry) {
    return entry && (entry.expiresAt === 0 || entry.expiresAt > now());
  }

  // 过期条目在真实 KV 里是「墓碑」：不出现，但也不会立刻回收。
  function sweep(key) {
    const e = map.get(key);
    if (e && !alive(e)) map.delete(key);
  }

  return {
    stats,

    async put(key, value, options = {}) {
      stats.puts++;
      if (key.length > 512) throw new Error(`KV key 超过 512 字节：${key.length}`);

      let bytes;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      else throw new Error("put 的值类型不支持");

      if (bytes.byteLength > VALUE_LIMIT) {
        throw new Error(`value 超过 25 MiB：${bytes.byteLength}`);
      }

      let metadata = options.metadata;
      if (metadata !== undefined) {
        const size = new TextEncoder().encode(JSON.stringify(metadata)).length;
        if (size > META_LIMIT) {
          throw new Error(`metadata 超过 1024 字节：${size}`);
        }
        // 真实 KV 存的是 JSON 的副本：改原对象不影响已存值
        metadata = JSON.parse(JSON.stringify(metadata));
      }

      const ttl = Number(options.expirationTtl) || 0;
      map.set(key, {
        value: bytes,
        metadata,
        expiresAt: ttl > 0 ? now() + ttl * 1000 : 0,
      });
      return undefined;
    },

    async get(key, options = {}) {
      stats.gets++;
      sweep(key);
      const e = map.get(key);
      if (!e) return null;
      const type = options.type || "text";
      if (type === "arrayBuffer") {
        return e.value.buffer.slice(e.value.byteOffset, e.value.byteOffset + e.value.byteLength);
      }
      if (type === "json") return JSON.parse(new TextDecoder().decode(e.value));
      return new TextDecoder().decode(e.value);
    },

    async getWithMetadata(key, options = {}) {
      stats.gets++;
      sweep(key);
      const e = map.get(key);
      if (!e) return { value: null, metadata: null };
      const type = options.type || "text";
      let value;
      if (type === "arrayBuffer") {
        value = e.value.buffer.slice(e.value.byteOffset, e.value.byteOffset + e.value.byteLength);
      } else if (type === "json") {
        value = JSON.parse(new TextDecoder().decode(e.value));
      } else {
        value = new TextDecoder().decode(e.value);
      }
      return { value, metadata: e.metadata ?? null };
    },

    async delete(key) {
      stats.deletes++;
      map.delete(key);
      return undefined;
    },

    async list(options = {}) {
      stats.lists++;
      const prefix = options.prefix || "";
      // pageSize 让测试能用很小的页逼出翻页逻辑；真实 KV 的上限是 1000
      const limit = Math.min(Number(options.limit) || LIST_LIMIT, LIST_LIMIT, pageSize);

      const all = [...map.keys()]
        .filter((k) => k.startsWith(prefix))
        .filter((k) => {
          sweep(k);
          return map.has(k);
        })
        .sort(); // 真实 KV 按字典序返回

      // cursor 就是「上一页最后一条的 key」——够用，也贴合真实语义
      let start = 0;
      if (options.cursor) {
        const at = all.indexOf(options.cursor);
        start = at >= 0 ? at + 1 : 0;
      }
      const page = all.slice(start, start + limit);
      const complete = start + page.length >= all.length;

      return {
        keys: page.map((name) => {
          const e = map.get(name);
          return { name, expiration: e.expiresAt ? Math.floor(e.expiresAt / 1000) : undefined, metadata: e.metadata ?? null };
        }),
        list_complete: complete,
        cursor: complete ? undefined : page[page.length - 1],
      };
    },

    // 测试辅助
    _dump() {
      return [...map.entries()].map(([k, v]) => ({ key: k, size: v.value.byteLength, metadata: v.metadata }));
    },
    _size() {
      return map.size;
    },
    _resetStats() {
      stats.gets = stats.puts = stats.deletes = stats.lists = 0;
    },
  };
}

/** 造一个能直接喂给 router 的 env */
export function createEnv({ password = "test-password", apiToken = "", kv = null } = {}) {
  return {
    CSV_KV: kv || createKv(),
    ACCESS_PASSWORD: password,
    API_TOKEN: apiToken,
    SESSION_SECRET: "test-session-secret-0123456789",
    PUBLIC_ORIGIN: "",
  };
}

/** 构造 Request，并给出与 Pages 一致的 context */
export function ctx(env, path, init = {}) {
  const request = new Request(`https://example.com/api${path}`, init);
  return {
    request,
    env,
    params: {},
    data: {},
    next: async () => new Response("not found", { status: 404 }),
    waitUntil: () => {},
  };
}
