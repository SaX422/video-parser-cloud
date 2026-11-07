/* ==========================================================================
 *  api-registry.js —— 解析源注册表（API 清单 + 字段契约 + 注释）
 *  --------------------------------------------------------------------------
 *  本文件是「API 清单」的代码化载体，逻辑严格对照 Java 插件 main.java：
 *  Java 端依次尝试多个第三方解析接口，任一成功即返回，全失败则报错。
 *  这里把同样的「多源降级」策略搬到浏览器端。
 *
 *  ⚠️ 关键差异 —— 浏览器同源策略（CORS）【已实测确认 2026-11】
 *    Java 插件跑在 Android 进程里，网络请求没有跨域限制；
 *    浏览器 fetch 会被 CORS 拦截。实测结论：下列所有第三方解析源
 *    均【不返回】Access-Control-Allow-Origin 头；同时公共 CORS 代理
 *    （allorigins / corsproxy.io / codetabs）当前已全部失效或转收费。
 *    ⇒ 唯一可行方案 = 本地网关 gateway.py 做服务端转发（页面与接口同源）。
 *      正常流程只请求 GET /api/parse?url=...，由网关完成多源降级；
 *      本文件的 SOURCES 仅在「网关不可用」时作为浏览器直连的兜底尝试。
 * ========================================================================== */

/* ---------- 平台识别正则表（与 main.java 的 urlPattern 对齐） ---------- */
/**
 * 每个平台给出多个域名匹配规则；extract 时先用通用 URL 正则抓出链接，
 * 再用这里的规则判定平台，用于：① 点亮界面上的平台徽标；② 选择优先源。
 */
const PLATFORM_PATTERNS = {
  douyin: {
    name: '抖音',
    test: /(douyin\.com|iesdouyin\.com)/i,
  },
  kuaishou: {
    name: '快手',
    test: /(kuaishou\.com|kwai\.com)/i,
  },
  bilibili: {
    name: '哔哩哔哩',
    test: /(b23\.tv|bilibili\.com)/i,
  },
  xiaohongshu: {
    name: '小红书',
    test: /(xiaohongshu\.com|xhslink\.com)/i,
  },
  weishi: {
    name: '微视 / 视频号',
    test: /(weishi\.qq\.com|shipinhao\.weixin\.qq\.com)/i,
  },
  tiktok: {
    name: 'TikTok',
    test: /(tiktok\.com)/i, // 覆盖 vm.tiktok.com / vt.tiktok.com
  },
};

/* ---------- 通用 URL 提取正则 ---------- */
/**
 * 从「整段分享文案」里抠出 http(s) 链接。
 * 分享内容常形如：
 *   「7.32 复制打开抖音，看看【作者】的作品 https://v.douyin.com/xxxxx/」
 * 该正则只负责抓 URL 本身，平台判定交给 PLATFORM_PATTERNS。
 */
const URL_RE = /https?:\/\/[^\s"'<>，。！？、）】》]+/gi;

/* ==========================================================================
 *  解析源清单 SOURCES
 *  --------------------------------------------------------------------------
 *  字段说明：
 *    id        源标识
 *    name      显示名称
 *    build(u)  构造请求 URL，u 为已 encodeURIComponent 的原链接
 *    parse(text) 把原始响应文本解析成统一结构：
 *                 { type:'video'|'images', url?, images?[], title?, cover? }
 *                解析失败返回 null（会触发降级到下一个源）
 *    cors      是否通常允许浏览器直连
 *    proxyOk   是否允许经代理转发
 *    supports  适用的平台 id 数组；空数组 = 通用
 *    note      说明 / 备注（对应 Java 中的调用位置）
 * ========================================================================== */

const SOURCES = [
  /* ------------------------------------------------------------------
   * 源 1：video-crack v2（对应 main.java 首选接口）
   * GET http://47.99.158.118/video-crack/v2/parse?content={原链接}
   * 返回 JSON：{ code:"0", data:{ url } | { imageUrl:[...] } }
   *   - code=="0" 视为成功
   *   - data.url 存在 → 视频直链
   *   - data.imageUrl 为非空数组 → 图集
   * ------------------------------------------------------------------ */
  {
    id: 'videocrack',
    name: 'VideoCrack v2',
    build: (u) => `http://47.99.158.118/video-crack/v2/parse?content=${u}`,
    parse: (text) => {
      const j = safeJson(text);
      if (!j || String(j.code) !== '0' || !j.data) return null;
      const d = j.data;
      if (Array.isArray(d.imageUrl) && d.imageUrl.length) {
        return { type: 'images', images: d.imageUrl.slice(), title: d.title || '' };
      }
      if (d.url) return { type: 'video', url: d.url, title: d.title || '', cover: d.cover || '' };
      return null;
    },
    cors: false,
    proxyOk: true,
    supports: [],           // 通用
    note: 'main.java 首选源，code=="0" 判成功，兼容视频与图集两种返回。',
  },

  /* ------------------------------------------------------------------
   * 【已移除】源 2：guiguiya 聚合
   * 实测 2026-11：该接口已转为付费，无 ApiKey 时返回引导登录页
   * （"付费接口，请求未携带ApiKey秘钥"），免费调用永久不可用。
   * 保留注释仅作变更留痕，不再参与任何请求。
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------
   * 源 3：tangdouz（对应 main.java 第三接口）
   * GET https://api.tangdouz.com/dy.php?lj={原链接}
   * 返回「非标准 JSON 文本」，图集以特殊分隔符 `±img=` 拼接，例如：
   *   作者名https://a.jpg±img=https://b.jpg±img=https://c.jpg
   *   - 含 `±img=` → 拆图集
   *   - 否则整段视为视频直链
   * ------------------------------------------------------------------ */
  {
    id: 'tangdouz',
    name: 'Tangdouz',
    build: (u) => `https://api.tangdouz.com/dy.php?lj=${u}`,
    parse: (text) => {
      const raw = (text || '').trim();
      if (!raw) return null;
      const SPLIT = '±img=';
      if (raw.includes(SPLIT)) {
        // 首段可能混有作者名等前缀，用 URL 正则再清洗一次
        const images = raw
          .split(SPLIT)
          .map((s) => (s.match(/https?:\/\/\S+/) || [''])[0])
          .filter(Boolean);
        if (images.length) return { type: 'images', images };
        return null;
      }
      const m = raw.match(/https?:\/\/\S+/);
      if (m) return { type: 'video', url: m[0] };
      return null;
    },
    cors: false,
    proxyOk: true,
    supports: ['douyin'],   // 主要面向抖音
    note: '返回非标准文本，用 ±img= 分隔符解析图集；否则取首个 URL 作视频。',
  },

  /* ------------------------------------------------------------------
   * 【已移除】源 4：douyin.wtf 混合接口
   * 实测 2026-11：/api/hybrid/video_data 已 404（站点重构为 Astro + 异步任务：
   * POST /api/v1/parse 拿 task_id，再轮询 GET /api/v1/tasks/{id}），
   * 前端一次性取结果不适用，故移除。
   * ------------------------------------------------------------------ */
];

/* ---------- 公共 CORS 代理前缀：实测全部失效，已停用 ---------- */
/**
 * 2026-11 实测：
 *   api.allorigins.win   → 超时（连接无响应）
 *   corsproxy.io         → "A valid API key is required"（已转付费）
 *   api.codetabs.com     → 超时
 *   api.cors.lol         → 429 限流
 *   proxy.corsfix.com    → invalid_origin（需白名单）
 *   www.whateverorigin.org → 301
 * 故保留空数组：不再对已死代理发起无意义请求，直接走本地网关。
 */
const DEFAULT_PROXIES = [];

/* ==========================================================================
 *  网关配置 GATEWAY —— 当前唯一可用通道
 *  --------------------------------------------------------------------------
 *  gateway.py 同时做三件事：
 *    1) GET /api/parse?url=...   服务端代请求解析源（绕开 CORS），返回统一结构
 *    2) GET /api/proxy?url=...   流式转发媒体，支持 Range（可拖动进度条）
 *    3) 其余路径静态托管本目录页面（页面与接口同源）
 *
 *  默认取「当前页面 origin」：用 http://127.0.0.1:8787/ 打开页面时天然同源；
 *  若页面被 file:// 直接打开（无 origin），则回落到本机 8787 端口。
 * ========================================================================== */
const GATEWAY = {
  // 允许在设置里覆盖；留空则自动推断
  override: '',
  // 外部后端地址持久化键（页面刷新后仍生效）
  STORAGE_KEY: 'vp_gateway',

  /**
   * 解析当前应当使用的后端 base。
   * 优先级：
   *   1) 地址栏参数 ?api=https://xxx.trycloudflare.com   （会写入 localStorage，之后免参数）
   *      ?api=local / origin / auto / default  → 清除记忆，回到同源
   *   2) localStorage 里记忆的外部后端
   *   3) override 字段
   *   4) 当前页面 origin（Pages / 本地网关同源时天然正确）
   *   5) file:// 打开时兜底本机 8787
   */
  resolve() {
    let q = '';
    try {
      const qs = new URLSearchParams(location.search);
      q = (qs.get('api') || qs.get('backend') || '').trim();
    } catch (e) {
      q = '';
    }
    if (q) {
      if (/^(local|origin|auto|default|self)$/i.test(q)) {
        try { localStorage.removeItem(this.STORAGE_KEY); } catch (e) {}
      } else {
        const v = /^https?:\/\//i.test(q) ? q : 'https://' + q;
        const clean = v.replace(/\/+$/, '');
        try { localStorage.setItem(this.STORAGE_KEY, clean); } catch (e) {}
        return clean;
      }
    }
    try {
      const saved = (localStorage.getItem(this.STORAGE_KEY) || '').trim();
      if (saved) return saved.replace(/\/+$/, '');
    } catch (e) {}
    const o = (this.override || '').trim().replace(/\/+$/, '');
    if (o) return o;
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return location.origin;
    }
    return 'http://127.0.0.1:8787'; // file:// 打开时的兜底
  },

  /** 是否正在使用外部（非当前站点）后端 */
  isExternal() {
    try {
      return new URL(this.resolve()).origin !== location.origin;
    } catch (e) {
      return true;
    }
  },

  auto() {
    return this.resolve();
  },
  parseUrl(u) {
    return `${this.auto()}/api/parse?url=${encodeURIComponent(u)}`;
  },
  /** 媒体地址统一走网关，解决 http/https 混合内容与图片 Referer 校验 */
  media(u) {
    if (!u) return '';
    if (/^(data:|blob:)/i.test(u)) return u;
    return `${this.auto()}/api/proxy?url=${encodeURIComponent(u)}`;
  },
  healthUrl() {
    return `${this.auto()}/api/health`;
  },
};

/* ---------- 统一解析工具 ---------- */
/**
 * 容错 JSON 解析：部分接口会返回前后带空白/HTML 的文本，
 * 这里先尝试直接 parse，失败则截取首个 { 到末个 } 再试。
 */
function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

/* ---------- 平台识别：给定链接返回平台 id 或 null ---------- */
function detectPlatform(url) {
  for (const [id, p] of Object.entries(PLATFORM_PATTERNS)) {
    if (p.test.test(url)) return id;
  }
  return null;
}

/* ---------- 从文案中提取全部链接 ---------- */
function extractUrls(text) {
  const out = [];
  const seen = new Set();
  (text || '').replace(URL_RE, (m) => {
    const clean = m.replace(/[.,;、]+$/, ''); // 去掉结尾标点
    if (!seen.has(clean)) { seen.add(clean); out.push(clean); }
    return m;
  });
  return out;
}

/* ---------- 对外暴露（挂到全局，供 app.js / 控制台使用） ---------- */
window.VP_REGISTRY = {
  PLATFORM_PATTERNS,
  SOURCES,
  DEFAULT_PROXIES,
  GATEWAY,
  detectPlatform,
  extractUrls,
  safeJson,
};

/* 控制台友好输出，方便学习者直接查看 API 清单 */
console.log(
  '%c[VideoParser] 已注册 ' + SOURCES.length + ' 个解析源：\n' +
  SOURCES.map((s, i) => `  ${i + 1}. ${s.name} — ${s.note}`).join('\n'),
  'color:#5b8cff;font-weight:600'
);