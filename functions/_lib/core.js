/* ==========================================================================
 * core.js —— 短视频解析网关 · 云端共享内核（Cloudflare Workers 运行时）
 * --------------------------------------------------------------------------
 * 这是 gateway.py 的等价 JavaScript 移植，被 functions/api/*.js 复用：
 *
 *   /api/health  → 列出解析源与支持的平台
 *   /api/parse   → 服务端代请求第三方解析接口（绕开浏览器 CORS）
 *   /api/proxy   → 流式转发媒体，透传 Range / Content-Range（可拖动进度条）
 *
 * 与本地版的唯一区别：本文件运行在 Cloudflare 边缘节点，使用 fetch 而非
 * urllib；其余业务逻辑（源顺序、归一化、白名单）逐行对齐 gateway.py 2.0.0。
 *
 * 依赖：无。仅使用 Workers 标准 Web API（fetch / Headers / Response）。
 * ========================================================================== */

export const VERSION = '2.1.0';

export const UA_MB =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

export const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* --------------------------------------------------------------------------
 * 解析源清单（2026-11 实测结论）
 * candidates 是同一源的多个候选地址：sniper 为明文 http，边缘节点偶有拦截，
 * 因此同时准备 https 变体，任一可用即命中。
 * ------------------------------------------------------------------------ */
export const SOURCES = [
  {
    id: 'sniper',
    name: '视频直解 · video-crack v2',
    candidates: [
      (raw) => 'http://47.99.158.118/video-crack/v2/parse?content=' + encodeURIComponent(raw),
      (raw) => 'https://47.99.158.118/video-crack/v2/parse?content=' + encodeURIComponent(raw),
    ],
    note: '实测可用：抖音图文/视频、B站、多平台；返回 data.url 与 data.imageUrl[]',
  },
  {
    id: 'tangdouz',
    name: '糖豆子 · dy.php',
    candidates: [
      (raw) => 'https://api.tangdouz.com/dy.php?lj=' + encodeURIComponent(raw),
    ],
    note: '降级源：上游偶发 403，仅作兜底',
  },
];

/* 平台识别（与前端 api-registry.js 保持一致） */
export const PLATFORM_RULES = [
  ['douyin', /(douyin\.com|iesdouyin\.com|v\.douyin\.com)/i],
  ['bilibili', /(bilibili\.com|b23\.tv)/i],
  ['kuaishou', /(kuaishou\.com|chenzhongtech\.com|v\.kuaishou\.com)/i],
  ['xiaohongshu', /(xiaohongshu\.com|xhslink\.com)/i],
  ['weibo', /(weibo\.com|weibo\.cn)/i],
  ['tiktok', /tiktok\.com/i],
];

/* 媒体白名单：只转发这些 CDN，避免 /api/proxy 变成任意地址开放代理（SSRF） */
export const ALLOWED_HOST_SUFFIX = [
  // 抖音 / 字节系
  'douyin.com', 'douyinpic.com', 'douyinvod.com', 'douyinstatic.com',
  'amemv.com', 'snssdk.com', 'byteimg.com', 'bytecdn.cn', 'pstatp.com',
  'zjcdn.com', 'ixigua.com',
  // B 站
  'bilibili.com', 'bilivideo.com', 'bilivideo.cn', 'hdslb.com', 'biliimg.com',
  // 快手
  'kuaishou.com', 'chenzhongtech.com', 'gifshow.com', 'kwimgs.com',
  // 小红书 / 微博
  'xhscdn.com', 'xiaohongshu.com', 'weibocdn.com', 'sinaimg.cn',
  // TikTok
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'ibytedtos.com',
];

/* ==========================================================================
 * 工具函数
 * ========================================================================== */

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** 取 hostname，失败返回空串（不抛异常） */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch (e) {
    return '';
  }
}

export function isAllowedMedia(url) {
  const host = hostOf(url);
  if (!host) return false;
  for (const suffix of ALLOWED_HOST_SUFFIX) {
    if (host === suffix || host.endsWith('.' + suffix)) return true;
  }
  return false;
}

export function detectPlatform(url) {
  for (const [name, pattern] of PLATFORM_RULES) {
    if (pattern.test(url)) return name;
  }
  return 'unknown';
}

/** 带超时的文本 GET（服务端请求，不做任何 CORS 处理） */
export async function httpText(url, timeout = 18000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeout);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA_PC,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.douyin.com/',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await resp.text();
    return { status: resp.status, ctype: resp.headers.get('Content-Type') || '', text };
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
 * 归一化：把各家五花八门的响应统一成
 * { ok, title, cover, video, images[], msg }
 * 实测样例（sniper）：
 *   {"code":0,"msg":"success","data":{"cover":"..","imageUrl":[".."],"title":"..","url":null}}
 * ========================================================================== */
export function normalize(payloadText) {
  let d;
  try {
    d = JSON.parse(payloadText);
  } catch (e) {
    // 部分源返回纯文本，尝试从中抠出 mp4 链接
    const m = payloadText.match(/https?:\/\/[^\s'"<>]+?\.mp4[^\s'"<>]*/);
    return {
      ok: !!m, video: m ? m[0] : '', images: [], title: '', cover: '',
      msg: '非 JSON 响应', raw: payloadText.slice(0, 400),
    };
  }
  if (!d || typeof d !== 'object') {
    return { ok: false, video: '', images: [], title: '', cover: '', msg: '响应不是对象' };
  }

  const data = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : {};
  const code = String(d.code !== undefined ? d.code
    : d.status_code !== undefined ? d.status_code
    : d.status !== undefined ? d.status : '');

  let video = data.url || data.video_url || d.url || '';
  if (typeof video === 'string' && video.endsWith('.mp3')) video = '';

  let images = data.imageUrl || data.image_url || data.images || [];
  if (typeof images === 'string') images = [images];
  if (!Array.isArray(images)) images = [];
  images = images.filter((x) => typeof x === 'string' && x.startsWith('http'));

  const cover = data.cover || data.origin_cover || '';
  const title = data.title || data.desc || '';

  if (!video && cover && !images.length) images = [cover];

  const ok = ['0', '200', 'true'].includes(code) && !!(video || images.length);
  return {
    ok, video: video || '', images, title: title || '', cover: cover || '',
    msg: d.msg || d.message || '', raw: null,
  };
}

/* ==========================================================================
 * 主解析入口：按源顺序尝试，返回统一结构 + 每个源的失败原因
 * ========================================================================== */
export async function parseLink(rawUrl) {
  const clean = (rawUrl || '').trim();
  if (!clean) return { ok: false, error: '缺少 url 参数' };

  const platform = detectPlatform(clean);
  const errors = [];

  for (const src of SOURCES) {
    let lastErr = null;
    let done = false;

    for (const build of src.candidates) {
      const target = build(clean);
      let resp;
      try {
        resp = await httpText(target, 18000);
      } catch (e) {
        lastErr = (e && e.name === 'AbortError') ? 'timeout 18s'
          : ((e && e.message) ? String(e.message).slice(0, 80) : 'fetch failed');
        continue;
      }

      if (resp.status >= 400) {
        lastErr = 'HTTP ' + resp.status;
        continue;
      }

      const res = normalize(resp.text);
      if (res.ok) {
        return {
          ok: true,
          source: src.id,
          sourceName: src.name,
          platform,
          url: clean,
          title: res.title,
          cover: res.cover,
          video: res.video,
          images: res.images,
          media: res.video ? 'video' : 'images',
          errors,
        };
      }
      lastErr = (res.msg || '响应无法识别').slice(0, 120);
      done = true;
      break; // 有响应但内容不可用 → 换下一源
    }

    errors.push({ source: src.id, error: lastErr || '无可用候选地址' });
    if (done) continue;
  }

  return {
    ok: false, platform, url: clean,
    error: '全部解析源均失败', errors,
  };
}

/* ==========================================================================
 * 媒体流代理：透传 Range / Content-Range，返回可流式播放的 Response
 * CF 边缘可能剥离 Content-Length，因此对响应头做「有则透传」处理。
 * ========================================================================== */
export async function proxyMedia(request) {
  const u = new URL(request.url);
  const target = u.searchParams.get('url') || '';

  if (!target || !/^https?:\/\//i.test(target)) {
    return jsonResponse({ ok: false, error: '缺少合法 url' }, 400);
  }
  // SSRF 防护
  if (!isAllowedMedia(target)) {
    return jsonResponse({
      ok: false,
      error: '域名不在媒体白名单内：' + (hostOf(target) || target) +
        '（如确需放行，请加入 functions/_lib/core.js 的 ALLOWED_HOST_SUFFIX）',
    }, 403);
  }

  const headers = {
    'User-Agent': UA_PC,
    Accept: '*/*',
    Referer: 'https://www.douyin.com/',
  };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), 25000);

  let upstream;
  try {
    upstream = await fetch(target, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    return jsonResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) }, 502);
  }

  if (upstream.status >= 400) {
    clearTimeout(timer);
    return jsonResponse({ ok: false, error: 'upstream HTTP ' + upstream.status }, 502);
  }

  const out = new Headers();
  out.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  const pass = ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'];
  for (const k of pass) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes');
  out.set('Cache-Control', 'public, max-age=3600');
  for (const [k, v] of Object.entries(corsHeaders())) out.set(k, v);

  // 流式转发，不在边缘缓冲整段视频
  if (!upstream.body) {
    clearTimeout(timer);
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/* ==========================================================================
 * 健康检查
 * ========================================================================== */
export function healthPayload() {
  return {
    ok: true,
    version: VERSION,
    runtime: 'cloudflare-pages-functions',
    sources: SOURCES.map((s) => ({ id: s.id, name: s.name, note: s.note })),
    platforms: PLATFORM_RULES.map((p) => p[0]),
  };
}

