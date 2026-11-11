// Pages Functions 入口。
// 文件位于 functions/api/[[path]].js，路由 /api/* 全部交给 functions/_lib/router.js。
import { handle } from "../_lib/router.js";

export const onRequest = (context) => handle(context);
