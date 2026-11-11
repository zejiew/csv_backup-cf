// Cloudflare Workers 入口（Static Assets 形态）。
//
// 为什么需要这个文件：把仓库连到 Cloudflare 建 Worker 时，如果仓库里没有
// `main` 指向的脚本，这个 Worker 会被判定为「只有静态资产」——此时面板会禁用
// 运行时变量、绑定、Logpush 等全部设置，报「不能将变量添加到只有静态资产的 Worker」。
// 有了这个入口，它就是正常的 Worker，KV 绑定和密钥都能加。
//
// 路由策略与 Pages 形态保持一致：
//   /api/*  → 交给 functions/_lib/router.js（和 Pages 用的是同一份代码）
//   其余    → env.ASSETS 直接返回静态文件

import { handle } from "../functions/_lib/router.js";

const isApi = (pathname) => pathname === "/api" || pathname.startsWith("/api/");

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isApi(url.pathname)) {
      return handle({
        request,
        env,
        params: {},
        data: {},
        waitUntil: (p) => ctx?.waitUntil?.(p),
        next: () => env.ASSETS.fetch(request),
      });
    }

    // wrangler.jsonc 里配了 run_worker_first: ["/api/*"]，正常情况下静态请求
    // 不会走到这里；但直接访问 workers.dev、或改成 run_worker_first: true 时
    // 会进来，所以仍然要能正确回落到静态资源。
    if (env.ASSETS) {
      try {
        return await env.ASSETS.fetch(request);
      } catch {
        // 极端情况下静态资产取不到，给一个明确的说明而不是空白页
      }
    }

    return new Response(
      "静态资源绑定（ASSETS）不可用。请检查 wrangler.jsonc 里 assets.binding 是否为 \"ASSETS\"。",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  },
};
