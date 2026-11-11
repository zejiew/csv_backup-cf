# CSV 备份柜

把 CSV 一类的小文件（台账、导出表、日志）备份到 **Cloudflare KV**，网页上和命令行都能推。
部署在 **Cloudflare Pages** 上，不花钱：免费版给 1 GB 存储、每天 1000 次写入 / 10 万次读取。

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

## 部署：一键（推荐，不用命令行）

不需要 wrangler、不需要本机装 Node，全程在浏览器里点。

### 1. 把仓库推到 GitHub

新建一个空仓库，把 `csv-backup/` 目录里的东西推到根目录（`functions/`、`public/` 要在仓库根，别多套一层）。

### 2. Pages 里连仓库

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 选这个仓库。

构建配置照下面填，**这一步填错是最常见的失败原因**：

| 配置项 | 填什么 |
|---|---|
| Framework preset | `None` |
| Build command | **留空**（没有构建步骤，别填 `npm run build`） |
| Build output directory | `public` |
| Root directory | 留空（仓库根就是项目根） |

点 **Save and Deploy**。第一次构建会「成功」，但页面会告诉你还差配置——这是故意的，见下一步。

### 3. 面板里加两样东西

**a) KV 绑定**（存数据用）

项目 → **Settings** → **Bindings** → **Add** → **KV namespace**

- Variable name：`CSV_KV` ← 必须一模一样
- KV namespace：没有就先去 **Workers & Pages → KV** 建一个（名字随意）

> 绑定名写成 `csv_kv` 也能认（大小写和横线会自动归一），但别写成 `MY_KV` 这种
> 认不出来的名字——真写错了，页面会直接把该填什么写在屏幕上。

**b) 访问口令**（不加就等于拒绝服务）

项目 → **Settings** → **Environment variables** → **Add**

- Name：`ACCESS_PASSWORD`
- Value：你的登录密码
- 类型：**Secret**（加密存储，构建日志里看不到）

可选：`API_TOKEN`（给脚本推送用）、`SESSION_SECRET`（换口令时不让所有会话一起掉线）、
`PUBLIC_ORIGIN`（填你的正式域名，如 `https://backup.example.com`）。

### 4. 重新部署一次

环境变量和绑定改完要触发一次新构建才生效：**Deployments** → 右上 **Retry deployment**
（或者随便推一个 commit）。

打开 `https://<项目名>.pages.dev`，输口令就能用了。

> **部署完看到「还差一步」的页面是正常的。** 上面缺哪项它就列哪项，还带「去哪儿点」，
> 补完点「重新检测」即可，不用猜。

---

## 部署：命令行（可选）

想用 CLI 或自己的 CI 时：

```bash
cp wrangler.toml.example wrangler.toml     # 把 id 填进去
npx wrangler kv namespace create CSV_KV
npx wrangler pages deploy public --project-name csv-kv-backup
npx wrangler pages secret put ACCESS_PASSWORD --project-name csv-kv-backup
```

两种方式**不要混用**：用面板管绑定，就别让 `wrangler.toml` 里再声明一份
（仓库里默认只有 `.example`，就是为此）。

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

接进你现有的导出流程（Windows 的 `.bat`、`cron`、GitHub Actions 都行）：

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
| GET | `/api/health` | 健康检查，不需要登录 |
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

**不想装任何东西**（推荐先这样看一眼）：

```bash
node dev.mjs        # 等价 npm start
# → http://127.0.0.1:8788   口令 dev-password
```

这是一个零依赖的本地预览服务器：`/api/*` 跑的是和线上**同一份** `functions/_lib/router.js`，
静态文件直接读 `public/`，数据存在 `dev-data.json`（重启不丢，删掉即清空）。
它模拟了 KV 的分页、1024 B metadata 上限、25 MiB value 上限，但**不模拟边缘缓存**。

换口令 / 换端口：

```bash
ACCESS_PASSWORD=我的口令 PORT=9000 node dev.mjs

# 想看「刚部署完、还没配 KV / 口令」那个自检页面长什么样：
DEV_UNCONFIGURED=1 node dev.mjs
```

**用 wrangler 跑**（更接近线上，模拟边缘行为）：

```bash
cp .dev.vars.example .dev.vars      # 改掉里面的口令
npm run dev                          # npx wrangler pages dev public --kv CSV_KV
```

**不装 wrangler 也能自测**——后端逻辑用内存版 KV 跑，覆盖了 41 个用例：

```bash
npm test
```

```
  登录与会话
    ✓ 密码正确时下发会话 cookie
    ✓ 连续失败 10 次后被节流
    ✓ 跨站 Origin 的写操作被拒（CSRF）
  上传与列表
    ✓ 内容完全相同的重复上传 → unchanged，不写 KV
    ✓ 列表只花 1 次 KV list，不做 N+1 次 get
  ...
  全部通过（41 个）
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

## 已知边界

- KV **不是强一致**的：写入后其他边缘节点可能几十秒内读到旧值。本项目写后用 `cacheTtl: 0` 读到最新，
  但多端同时改同一个文件仍可能互相覆盖。单人备份场景够用。
- **没有多用户**。一个口令，所有人看到同一份数据。要多人隔离得改 key 前缀 + 各自口令。
- **回收站和版本会占存储**。1 GB 免费额度，长期跑建议定期清回收站。
- 大文件（几百 MB）不适合 KV。真要备份那种，用 R2。

### 部署报错时

| 现象 | 原因 |
|---|---|
| 构建成功但页面一直转圈 | `_routes.json` 没进输出目录。它必须在 `public/` 里 |
| 打开是 404 / 白屏 | Build output directory 填错了，应该是 `public`，不是 `csv-backup/public` |
| 页面显示「还差一步」 | 上面第 3 步没配完，或者没点 Retry deployment |
| 构建日志说 `Build command` 失败 | Build command 应该是**空的**，不要填 `npm run build` |

## 目录

```
csv-backup/
├── functions/                  # 全部后端代码都在这个目录里，Git 集成直接认
│   ├── api/[[path]].js         # 入口：/api/* 全交给 router
│   └── _lib/                   # 实际逻辑（`_` 开头，不会变成路由）
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
│   └── _routes.json            # 只有 /api/* 走 Functions（必须放在构建输出目录里）
├── test/                       # 内存 KV 模拟 + 41 个端到端用例
├── dev.mjs                     # 零依赖本地预览（不装 wrangler 也能跑）
├── wrangler.toml.example       # 只有 CLI 部署才需要复制成 wrangler.toml
└── .dev.vars.example           # wrangler 本地开发时的变量样例
```

## License

MIT
