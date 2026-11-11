# CSV 备份柜

把 CSV 一类的小文件（台账、导出表、日志）备份到 **Cloudflare KV**，网页上和命令行都能推。
部署在 **Cloudflare Workers**（静态资产），不花钱：免费版给 1 GB 存储、每天 1000 次写入 / 10 万次读取。

![接口示意](https://img.shields.io/badge/API-REST-2563eb) ![零依赖](https://img.shields.io/badge/dependencies-0-067647)

---

## 这个项目解决什么

你在本地生成 CSV（比如「代工厂物料台账」导出的 `库存表-2026-03.csv`），想**扔到云上留个底**，
又不想为这点事开数据库、配对象存储、写一整套后端。

Cloudflare KV 刚好够：写进去就跑，不用管机器。但它有几个硬限制，这个项目就是围绕它们设计的：

| 限制 | 项目里的处理 |
| --- | --- |
| 单个 value 最多 **25 MiB** | 单文件上限定 20 MiB，留余量；超了给明确提示，不会传一半 |
| metadata 最多 **1024 B** | 文件名、大小、标签、前 4 行预览全部压进 metadata，**列表一次 list 就够，不做 N+1 次 get** |
| 免费版 **1000 次写/天** | 内容没变就返回 `unchanged` 不写；列表不读正文；登录失败计数只在失败时写 |
| 同一个 key **1 次写/秒** | 文件名做 key 的一部分会撞车，所以正文按随机 `fileId` 存，改元数据才重写 |
| `list` 一次最多 1000 条 | 会跟随 `cursor` 翻页到底，不会「只显示前 1000 个」 |

## 用起来是什么样

- 登录口令 → 拖文件进去 → 列表里看到文件名、大小、更新时间、**前几行内容预览**
- 同名文件再传一次：旧内容自动进**历史版本**（每个文件留 10 份），不打乱、不丢
- 删掉的进**回收站**，随时还原；彻底删除才真删（连历史版本一起）
- 一键**整包导出**成 zip（内含 `_manifest.json`），换机器时带走
- 命令行 / 定时任务用 `API_TOKEN` 直接 `curl` 推送，不用管 cookie

---

## 部署

代码在 <https://github.com/zejiew/csv_backup-cf>。下面以「连 Git 自动部署」为主，全程在浏览器里点。

> **先看一条坑**：如果你是在 Cloudflare 建了一个 **Worker** 再连仓库，那么这个仓库里必须有
> `src/index.js`（本项目已有）——没有的话 Worker 会被判成「只有静态资产」，
> 面板会禁用变量和绑定，报 *「不能将变量添加到只有静态资产的 Worker」*。

### 1. 先建 KV 命名空间

Dashboard → **Storage & Databases** → **KV** → **Create instance**，名字随意（比如 `csv-backup-kv`）。

建好后进入该命名空间，复制它的 **ID**（一串十六进制），下一步要用。

### 2. 把 id 填进 wrangler.jsonc

```jsonc
"kv_namespaces": [
  {
    "binding": "CSV_KV",
    "id": "把刚才复制的 id 粘这里"
  }
],
```

提交并推送。

> 为什么必须写在文件里：Workers **每次部署都会按 `wrangler.jsonc` 重写绑定列表**，
> 只在面板里手加的绑定，下次部署就没了。
> 为什么不留给自动创建：Workers Builds 下自动创建不幂等，第二次部署会报 `10014`。

### 3. 连仓库

Dashboard → **Workers & Pages** → **Create** → **Connect to Git**（选 Worker，不是 Pages）→ 选仓库。

构建配置：

| 配置项 | 填什么 |
|---|---|
| Build command | **留空**（没有构建步骤，别填 `npm run build`） |
| Deploy command | 默认的 `npx wrangler deploy` 即可 |
| Root directory | 留空 |

### 4. 加口令（**必须**，不加就拒绝服务）

Worker → **Settings** → **Variables and Secrets** → **Add**（类型选 **Secret**）：

- `ACCESS_PASSWORD` = 你的登录密码

密钥保存在面板里，**不会被部署覆盖**。可选：`API_TOKEN`（脚本推送用）、
`SESSION_SECRET`（换口令时不让所有会话一起掉线）、`PUBLIC_ORIGIN`（你的正式域名）。

### 5. 部署完成后

打开 `https://<worker名>.<你的子域>.workers.dev`，输口令就能用了。

> 首次打开若看到「还差一步」的清单，说明 KV 绑定或口令还没生效，
> 照清单补完点「重新检测」即可，不用猜。

### 也可用 Pages 部署

仓库同时保留了 Pages 形态（`functions/` 目录 + `public/_routes.json`），
建 Pages 项目连同一个仓库、Build output directory 填 `public` 也能跑，代码完全一致。

---

## 命令行推送

```bash
# 用口令换会话
curl -c jar.txt -X POST https://你的域名/api/login \
     -H 'content-type: application/json' \
     -d '{"password":"你的口令"}'

# 推一个 CSV（原始字节流，最省事）
curl -b jar.txt -X POST 'https://你的域名/api/files?name=库存表-2026-03.csv' \
     -H 'content-type: text/csv' \
     --data-binary @库存表-2026-03.csv
```

有 `API_TOKEN` 的话，一步到位：

```bash
curl -X POST 'https://你的域名/api/files?name=库存表-2026-03.csv' \
     -H "Authorization: Bearer $API_TOKEN" \
     -H 'content-type: text/csv' \
     --data-binary @库存表-2026-03.csv
```

接进你现有的导出流程（`.bat`、`cron`、GitHub Actions 都行）：

```bash
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%Y-%m-%d)
curl -fsS -X POST "https://你的域名/api/files?name=库存表-${STAMP}.csv&tags=自动备份" \
     -H "Authorization: Bearer $API_TOKEN" \
     -H 'content-type: text/csv' \
     --data-binary @./data/inventory.csv
```

> 注意：同名会覆盖并留旧版。想每次留独立文件就用带日期的文件名（如上）。
> 但每天一个新文件 = 每天一个新 key，**免费版 1000 次写/天**够用，别做成每小时。

## 接口一览

除 `/health`、`/me`、`/login`、`/logout` 外都要登录（cookie 或 Bearer Token）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 配置自检，不需要登录 |
| GET | `/api/me` | 当前是否已登录、服务端有没有配口令 |
| POST | `/api/login` | `{"password":"..."}`，成功后下发 cookie |
| POST | `/api/logout` | 清 cookie |
| GET | `/api/stats` | 文件数、占用、标签分布、最近更新 |
| GET | `/api/files` | 列表（含预览与版本数） |
| POST | `/api/files` | 上传：`multipart`（字段 `file`）或原始字节流 + `?name=` |
| GET | `/api/files/:id` | 详情 + 历史版本列表 |
| PATCH | `/api/files/:id` | `{"name":"新名.csv","tags":["a","b"]}` |
| DELETE | `/api/files/:id` | 移到回收站 |
| GET | `/api/files/:id/download` | 下载当前版本 |
| GET | `/api/files/:id/versions` | 历史版本列表 |
| GET | `/api/files/:id/versions/:seq/download` | 下载某个历史版本 |
| POST | `/api/files/:id/versions/:seq/restore` | 回滚到某个历史版本 |
| GET | `/api/trash` | 回收站 |
| POST | `/api/trash/:id/restore` | 从回收站还原 |
| DELETE | `/api/trash/:id` | 彻底删除（不可恢复） |
| GET | `/api/export` | 全部文件打成 zip |

出错时统一返回 `{"ok":false,"code":"...","message":"..."}`，`message` 可以直接给人看。

## 本地跑

**不想装任何东西**：

```bash
node dev.mjs          # Pages 形态   → http://127.0.0.1:8788
node dev-worker.mjs   # Workers 形态 → http://127.0.0.1:8789
```

两个都是零依赖预览服务器，跑的是和线上**同一份**业务代码（`functions/_lib/`），
数据存在 `dev-data.json`（重启不丢，删掉即清空）。
`dev-worker.mjs` 走 `src/index.js`，用来验证「连 Git 建 Worker」那条路径的分流逻辑。

换口令 / 端口 / 看未配置状态：

```bash
ACCESS_PASSWORD=我的口令 PORT=9000 node dev.mjs
DEV_UNCONFIGURED=1 node dev.mjs      # 预览「还没配 KV / 口令」的自检页面
```

**不装 wrangler 也能自测**——后端逻辑用内存版 KV 跑，**53 个用例**：

```bash
npm test              # 先校验 wrangler.jsonc，再跑 53 个用例
npm run test:unit     # 只跑用例
npm run check         # 只校验部署配置（会提醒你 KV id 还没填）
```

```
  Workers 入口：静态与 API 分流
    ✓ /api/health 交给 router，且返回正常 JSON
    ✓ /apixxx 不是 API 路径，应走静态资产
  ...
  全部通过（53 个）
```

这套测试用的 KV 模拟**故意保留了真实 KV 的坑**（list 分页、metadata 1024 B 上限、value 25 MiB 上限），
所以它抓到的 bug 是线上也会有的。

## 为什么不这么做

几个当初考虑过、最后没用的方案，写下来省得以后再想一遍：

- **正文也塞 metadata**：metadata 上限 1024 B，装不下 CSV，而且列表会变贵。
- **文件名当 key**：改个名就要删旧建新，还撞「同 key 1 次/秒」的限制。用随机 id 稳定。
- **写个 D1 数据库**：就备份几个 CSV，查询需求约等于零，KV 更省事、也免费。
- **前端上框架**：整个界面就三个文件，`fetch` + 原生 DOM 够了，免构建。
- **用 JWT 库**：`crypto.subtle` 自带 HMAC，签个 `{exp}` 的 payload 就够，没必要引依赖。
- **只放静态页、绑定在面板加**：会被下次部署覆盖，见上面第 2 步。

## 已知边界

- KV **不是强一致**的：写入后其他边缘节点可能几十秒内读到旧值。本项目写后用 `cacheTtl: 0` 读到最新，
  但多端同时改同一个文件仍可能互相覆盖。单人备份场景够用。
- **没有多用户**。一个口令，所有人看到同一份数据。要多人隔离得改 key 前缀 + 各自口令。
- **回收站和版本会占存储**。1 GB 免费额度，长期跑建议定期清回收站。
- 大文件（几百 MB）不适合 KV。真要备份那种，用 R2。

### 部署报错时

| 现象 | 原因 |
|---|---|
| 提示「不能将变量添加到只有静态资产的 Worker」 | 仓库缺 `src/index.js`，或 `wrangler.jsonc` 里没有 `main` |
| 部署报 `10014` | KV 的 `id` 那行还是占位符，去第 1 步建一个填上 |
| 打开是 404 / 白屏 | `assets.directory` 应为 `./public` |
| 页面显示「还差一步」 | KV 绑定或 `ACCESS_PASSWORD` 没生效，补完点「重新检测」 |
| 加了绑定，下次部署又没了 | 绑定要写在 `wrangler.jsonc` 里，不是面板里 |
| 构建日志说命令失败 | Build command 应该是**空的** |

## 目录

```
csv-backup/
├── src/index.js                # Workers 入口：/api/* 交给 router，其余交给 ASSETS
├── wrangler.jsonc              # Worker 配置（名称、静态资产、KV 绑定）
├── functions/                  # 同一份后端代码，Pages 形态也从这里走
│   ├── api/[[path]].js         # Pages 入口：/api/* 全交给 router
│   └── _lib/                   # 实际逻辑
│       ├── config.js           # 限制常量、凭据与 KV 绑定解析、配置自检
│       ├── http.js             # 统一响应、错误类型、限长读体
│       ├── auth.js             # HMAC 会话、API Token、CSRF、失败节流
│       ├── store.js            # KV 数据模型（key 设计、版本、回收站、统计）
│       ├── zip.js              # 零依赖 zip 打包（deflate-raw + CRC32）
│       └── router.js           # 路由与各处理器
├── public/                     # 静态前端，免构建
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── _routes.json            # Pages 形态用（Workers 形态忽略）
├── test/                       # 内存 KV 模拟 + 53 个端到端用例
├── dev.mjs                     # 本地预览（Pages 形态）
├── dev-worker.mjs              # 本地预览（Workers 形态）
├── wrangler.toml.example       # 只在用 `wrangler pages deploy` 时才需要
└── .dev.vars.example           # wrangler 本地开发时的变量样例
```

## License

MIT
