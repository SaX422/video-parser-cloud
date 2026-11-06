# 短视频解析 · 云端版（Cloudflare Pages + Pages Functions）

把本地 `gateway.py` 的能力整套搬到 Cloudflare 边缘：**静态页面 + 同源 `/api/*` 接口**，
一次部署，手机/电脑/任何人生成链接都能用。

---

## 一、为什么不能只传静态文件（关键认知）

`gateway.py` 解决的是 **CORS**：四个第三方解析接口都不返回 `Access-Control-Allow-Origin`，
浏览器直连必然被拦，这就是“每次都解析失败”的真因。

Cloudflare Pages 的纯静态托管 **不执行 Python**。如果你只把 `index.html`+`app.js` 传上去，
接口层就消失了，页面直连上游 → 重新撞 CORS → 退回原始故障。

所以必须用 **Pages Functions**（Workers 运行时）承载三个接口，
让页面与接口继续同源。本仓库已经是这个结构，直接部署即可。

```
请求 https://your-site.pages.dev/api/parse?url=...
        │
        ▼
Cloudflare 边缘 (functions/api/parse.js)  ← 代替 gateway.py
        │  fetch（无 CORS 限制，无需代理）
        ▼
第三方解析源 (video-crack v2 / tangdouz)
        │  返回媒体直链
        ▼
前端 <video src="/api/proxy?url=...">  ← 同源 + 支持 Range 拖动
```

---

## 二、目录结构

```
video-parser-cloud/
├── index.html              页面
├── style.css               样式
├── app.js                  前端逻辑（默认走同源网关）
├── api-registry.js         源清单 + GATEWAY 地址推断
├── _routes.json            只让 /api/* 触发 Functions，静态资源直出（省额度、更快）
├── _headers                Pages 响应头
├── robots.txt              不想被搜索引擎收录就留着
├── wrangler.toml           可选：本地 dev / 命令行部署
└── functions/
    ├── _lib/
    │   └── core.js         内核：源清单、normalize、白名单、流式代理（= gateway.py 的 JS 版）
    └── api/
        ├── health.js       GET /api/health
        ├── parse.js        GET /api/parse?url=...
        └── proxy.js        GET /api/proxy?url=...
```

`functions/api/xxx.js` 的文件路径就是路由，无需任何注册代码。

---

## 三、上传 GitHub（两种方式，任选）

### 方式 A：网页上传（不装任何工具）

1. 打开 https://github.com/new ，仓库名 `video-parser-cloud`，选 **Public**（Private 也能连 Pages，但免费版协作者受限），
   **不要**勾选 Add README / .gitignore。
2. 创建后点 **uploading an existing file**。
3. 把本项目**根目录下的所有文件**拖进去：
   - `index.html` `style.css` `app.js` `api-registry.js`
   - `_routes.json` `_headers` `robots.txt` `README.md` `wrangler.toml`
   - `functions/` 整个目录（含 `_lib/core.js` 与 `api/*.js`）
4. ⚠️ **拖拽上传不会保留子目录**，`functions/` 需要手动逐个建：
   - Add file → Create new file → 文件名输入 `functions/api/health.js`（输入 `/` 会自动建目录）→ 粘贴内容
   - 同理创建 `functions/api/parse.js`、`functions/api/proxy.js`、`functions/_lib/core.js`
5. Commit。

### 方式 B：命令行（推荐，目录结构一次到位）

```bash
cd video-parser-cloud
git init
git add .
git commit -m "feat: cloudflare pages functions 版短视频解析"
git branch -M main
git remote add origin https://github.com/<你的用户名>/video-parser-cloud.git
git push -u origin main
```

> 手机上没有 git 时，用 Termux：
> `pkg install git -y`，再执行上面命令；
> 认证用 **Personal Access Token** 当密码（GitHub → Settings → Developer settings → Tokens (classic) → repo 勾选）。

---

## 四、Cloudflare 连接仓库部署

1. 登录 https://dash.cloudflare.com → 左侧 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 授权 GitHub，选中刚建的仓库 → **Begin setup**。
3. 构建配置**必须这样填**（这是本项目唯一容易填错的地方）：

   | 字段 | 填什么 |
   | --- | --- |
   | Project name | `video-parser`（决定 `video-parser.pages.dev`） |
   | Production branch | `main` |
   | Framework preset | **None** |
   | Build command | **留空** |
   | Build output directory | **`/`** 或留空（页面就在仓库根目录） |
   | Root directory | 留空 |

   > 不要填 `npm run build`、不要填 `dist`。本项目零依赖、无构建步骤；
   > 填了构建命令会让 Pages 找不到 `functions/` 之外的产物，反而把接口弄丢。

4. **Save and Deploy** → 等 30 秒左右 → 拿到 `https://video-parser.pages.dev`。
5. 之后每次 `git push`，Pages 自动重新部署；PR 会生成独立的预览域名。

---

## 五、部署后验证（三条命令，缺一不可）

把 `<域名>` 换成你的 `xxx.pages.dev`。手机浏览器/电脑终端都能跑。

### 1. 接口是否真的在跑

```bash
curl -sS https://<域名>/api/health
```

期望：`{"ok":true,"version":"2.1.0","runtime":"cloudflare-pages-functions","sources":[...]}`

- 若返回 **HTML（页面内容）** → `functions/` 没上传成功，或 Build output directory 填错。
- 若返回 **404** → 同上。

### 2. 解析是否通

```bash
curl -sS "https://<域名>/api/parse?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1GJ411x7h7"
```

期望：`"ok":true` 且带 `video`（或 `images`）。

### 3. 媒体代理 + Range 是否透传

```bash
curl -sS -o /dev/null -D - -H "Range: bytes=0-1023" \
  "https://<域名>/api/proxy?url=<上一步返回的 video 地址，URL 编码>"
```

期望：`HTTP/2 206`、`content-type: video/mp4`、`content-range: bytes 0-1023/...`。

本地已实测通过（Node 直跑内核）：

```
status = 206
content-type = video/mp4
content-range = bytes 0-1023/51973319
accept-ranges = bytes
acao = *
bytes = 1024 magic = ftypisom
```

白名单拦截也已验证：`/api/proxy?url=https://evil.com/a.mp4` → `403`。

最后打开首页，状态栏应显示 **“解析通道就绪 · 页面与接口同源”**；粘贴分享链接即可解析。

---

## 六、前端为什么不用改地址

`api-registry.js` 里：

```js
auto() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return location.origin;          // 部署到 pages.dev 自动指向同源
  }
  return 'http://127.0.0.1:8787';    // file:// 双击打开时回落本地
}
```

同一份代码，本地 `python3 gateway.py` 能用，云端 Pages 也能用。

---

## 七、必须知道的行为差异（本地 vs 云端）

| 项 | 本地 `gateway.py` | 云端 Pages Functions |
| --- | --- | --- |
| 静态托管 | 自带 `serve_static` | Cloudflare 静态层（更快，可 CDN 缓存） |
| 解析 | `urllib` | `fetch`（边缘节点，出口 IP 为 Cloudflare） |
| 媒体代理 | 64KB 循环写回 | `Response(upstream.body)` 流式管道 |
| `Content-Length` | 原样透传 | **可能被边缘剥离**；播放器依赖 `Content-Range` 与流式读取，实测不影响播放和拖动 |
| 上游 `http://` 源 | 直接可用 | 同时准备了 `https://` 候选地址，任一命中即可 |
| 单次请求 CPU | 无限制 | 免费版 10ms CPU（**只算 CPU，不算等待上游 IO 的时间**，本项目几乎不耗 CPU） |
| 请求数 | 无限制 | 免费版 10 万次/天 |
| 子请求 | 无限制 | 单请求最多 50 次 fetch（本项目最多 3 次） |
| 冷启动 | 无 | 边缘节点已预热，影响很小 |

结论：本项目在免费额度内可以长期跑，瓶颈只会是**第三方解析源自己挂掉**。

---

## 八、常见问题排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 首页能开，解析全失败 | `functions/` 未部署 | 访问 `/api/health` 确认；补传目录后重新部署 |
| `/api/health` 返回 HTML | Build output directory 填成了 `dist` 之类 | Pages 设置里改成 `/` |
| `502 upstream HTTP 403` | 第三方源风控（tangdouz 常见） | 属上游问题；sniper 为主源，已配降级 |
| 视频转圈不动 | 媒体域名不在白名单 | 在 `functions/_lib/core.js` 的 `ALLOWED_HOST_SUFFIX` 追加后缀 |
| 图片 403 | 同上 / CDN 需 Referer | 已在代理里固定 `Referer: https://www.douyin.com/` |
| 部署成功但改了没生效 | 浏览器缓存 | 强制刷新；静态资源已设 `no-cache` 由 Pages 控制 |
| 想用自己的域名 | — | Pages → Custom domains → 添加；域名托管在 CF 时自动配好 CNAME |

---

## 九、可选：本地预览与命令行部署

```bash
# 本地起一个和线上完全一致的运行时（含 Functions）
npx wrangler pages dev . --port 8787

# 命令行直接发布（不用 Git 集成）
npx wrangler pages deploy . --project-name video-parser
```

`wrangler.toml` 已写好 `pages_build_output_dir = "."`，直接可用。

---

## 十、说明

- 解析能力来自第三方公开接口，可用性由对方决定，本项目只做转发与格式归一化。
- 媒体转发带域名白名单，避免站点被当成开放代理滥用（SSRF）。
- 上线后若不希望被搜索到，保留 `robots.txt` 的 `Disallow: /`；
  需要更严的访问控制，可在 Cloudflare Zero Trust → Access 给 `*.pages.dev` 加登录策略。
