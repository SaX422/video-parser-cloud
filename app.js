/* ==========================================================================
 *  app.js —— 短视频解析引擎 + UI 状态机
 *  --------------------------------------------------------------------------
 *  模块划分：
 *    1. 状态与工具
 *    2. UI 引用与主题
 *    3. Liquid Glass 指针高光
 *    4. 网络层：requestSource() —— 直连 / 代理三级降级
 *    5. 解析流水线：runParse() —— 多源降级
 *    6. 结果渲染：renderResult()
 *    7. 交互绑定：输入 / 按钮 / 抽屉 / 剪贴板
 * ========================================================================== */

/* =======================  1. 状态与工具  ======================= */
const R = window.VP_REGISTRY;

const state = {
  mode: 'gateway',       // gateway（默认，唯一可用） | direct（浏览器直连，仅调试） | proxy（已失效）
  proxyPrefix: '',       // 自定义网关地址（覆盖 GATEWAY.auto()）
  timeout: 30000,        // 网关要串行尝试多个上游源，默认放宽到 30s
  autoplay: true,
  skipFailed: false,     // 【重要】默认关闭：否则一次全失败会永久跳过所有源
  showSteps: true,
  current: null,         // 当前解析结果
  failedHosts: new Set(),// 失败源缓存（仅本次会话有效，不再持久化）
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/** 读取 localStorage 里的持久化设置 */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('vp_settings') || '{}');
    // 迁移：旧版本的 failedHosts 缓存会「一次失败=永久跳过全部源」，这里清洗掉
    delete saved.failedHosts;
    Object.assign(state, saved);
    state.failedHosts = new Set(); // 失败缓存只在本次会话内有效
    // 迁移：旧版本默认模式 auto / direct 均会走已失效的公共代理
    if (!['gateway', 'direct', 'proxy'].includes(state.mode)) state.mode = 'gateway';
  } catch (_) {}
  R.GATEWAY.override = state.proxyPrefix || '';
}
/** 写入持久化设置 */
function saveSettings() {
  const { mode, proxyPrefix, timeout, autoplay, skipFailed, showSteps } = state;
  localStorage.setItem(
    'vp_settings',
    JSON.stringify({ mode, proxyPrefix, timeout, autoplay, skipFailed, showSteps })
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMobile = () => matchMedia('(max-width:640px)').matches;

/* =======================  2. UI 引用与主题  ======================= */
const els = {
  url: $('#url'),
  inputShell: $('#inputShell'),
  clearBtn: $('#clearBtn'),
  parseBtn: $('#parseBtn'),
  parseBtnText: $('#parseBtnText'),
  pasteBtn: $('#pasteBtn'),
  chips: $('#chips'),
  status: $('#status'),
  statusText: $('#statusText'),
  steps: $('#steps'),
  result: $('#result'),
  mediaBox: $('#mediaBox'),
  galleryWrap: $('#galleryWrap'),
  infoGrid: $('#infoGrid'),
  copyUrlBtn: $('#copyUrlBtn'),
  downloadBtn: $('#downloadBtn'),
  openBtn: $('#openBtn'),
  againBtn: $('#againBtn'),
  themeBtn: $('#themeBtn'),
  themeIcon: $('#themeIcon'),
  settingsBtn: $('#settingsBtn'),
  drawer: $('#drawer'),
  drawerMask: $('#drawerMask'),
  closeDrawer: $('#closeDrawer'),
  modeSeg: $('#modeSeg'),
  proxyPrefix: $('#proxyPrefix'),
  timeout: $('#timeout'),
  autoplay: $('#autoplay'),
  skipFailed: $('#skipFailed'),
  showSteps: $('#showSteps'),
  toasts: $('#toasts'),
  lightbox: $('#lightbox'),
  lbImg: $('#lbImg'),
  lbClose: $('#lbClose'),
  apiCount: $('#apiCount'),
  modeLabel: $('#modeLabel'),
};

/* 主题：dark / light，跟随设置持久化 */
const SUN = `<circle cx="12" cy="12" r="4.2"/>
  <path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M19.8 4.2l-1.7 1.7"/>`;
const MOON = `<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z"/>`;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeIcon.innerHTML = theme === 'dark' ? SUN : MOON;
  localStorage.setItem('vp_theme', theme);
}

/* =======================  3. Liquid Glass 指针高光  ======================= */
/** 让 .glass 元素的光斑跟随指针，实现「镜面玻璃」质感 */
function bindGlassHover() {
  $$('.glass, .drawer').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
      el.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--mx', '50%');
      el.style.setProperty('--my', '0%');
    });
  });
}

/* =======================  4. 网络层：三级降级请求  ======================= */
/**
 * 带超时的 fetch 文本请求。
 * @param {string} url 目标地址
 * @returns {Promise<string>} 响应文本
 */
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), state.timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json,text/plain,*/*' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 【主通道】经本地网关请求解析：GET /api/parse?url=<原始链接>
 *
 * 为什么必须这样做：实测四个第三方解析源全部不返回
 * Access-Control-Allow-Origin，浏览器 fetch 一律被同源策略拦截；
 * 由 gateway.py 在服务端发起请求则完全没有 CORS 限制，
 * 再把结果以同源 JSON 返给页面。
 *
 * @param {string} rawUrl 原始分享链接（网关内部自行编码上游参数）
 * @returns {Promise<object>} 网关统一结构
 *   { ok, source, sourceName, platform, title, cover, video, images[], media, errors[] }
 */
async function requestGateway(rawUrl) {
  const text = await fetchText(R.GATEWAY.parseUrl(rawUrl));
  const j = R.safeJson(text);
  if (!j) throw new Error('接口返回内容无法解析：若为本地运行请启动 gateway.py，若已部署请确认 functions/ 目录已随仓库上传');
  if (!j.ok) {
    const detail =
      Array.isArray(j.errors) && j.errors.length
        ? j.errors.join('；')
        : j.msg || '全部解析源均失败';
    throw new Error(detail);
  }
  return j;
}

/** 把网关返回结构转成 UI 使用的统一结构 */
function normalizeGateway(j, platform, rawUrl) {
  const images = Array.isArray(j.images) ? j.images.filter(Boolean) : [];
  const video = j.video || '';
  let type = '';
  if (video) type = 'video';
  else if (images.length) type = 'images';
  if (!type) throw new Error('网关返回成功，但没有可用的媒体地址');

  return {
    type,
    url: video,
    images: type === 'images' ? images : [],
    title: j.title || '',
    cover: j.cover || '',
    source: j.sourceName || j.source || '本地网关',
    via: '网关 · ' + (j.source || 'sniper'),
    raw: rawUrl,
    platform: j.platform || platform,
  };
}

/** 网关健康检查（初始化时用于提示用户是否已启动服务） */
async function checkGateway() {
  try {
    const j = R.safeJson(await fetchText(R.GATEWAY.healthUrl()));
    return !!(j && j.ok);
  } catch (_) {
    return false;
  }
}

/**
 * 对单个解析源发起请求，按模式逐级降级：
 *   - direct：只直连，失败即失败（用于验证 CORS 是否放行）
 *   - proxy ：只走代理前缀
 *   - auto  ：先直连；若抛错（多为 CORS/网络）→ 依次尝试代理前缀
 *
 * ⚠️ 注意：这是【兜底旧链路】。实测所有源均无 CORS 头、公共代理已全灭，
 * 正常使用请保持 state.mode = 'gateway'。
 *
 * @param {object} src 解析源
 * @param {string} rawUrl 原始分享链接（未编码）
 * @returns {Promise<{text:string, via:string}>}
 */
async function requestSource(src, rawUrl) {
  const enc = encodeURIComponent(rawUrl);
  const target = src.build(enc);

  // —— 直连尝试 ——
  if (state.mode === 'direct' || (state.mode === 'auto' && src.cors !== false)) {
    try {
      const text = await fetchText(target);
      return { text, via: '直连' };
    } catch (e) {
      if (state.mode === 'direct') throw e; // 直连模式不再降级
    }
  }

  // —— 代理尝试 ——
  if (state.mode !== 'direct' && src.proxyOk !== false) {
    const proxies = state.proxyPrefix
      ? [state.proxyPrefix]
      : R.DEFAULT_PROXIES;
    let lastErr;
    for (const p of proxies) {
      try {
        const text = await fetchText(p + encodeURIComponent(target));
        return { text, via: '代理·' + hostOf(p) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('所有代理均失败');
  }

  throw new Error('该源在当前模式下不可用');
}

/** 从代理前缀里提取主机名，用于状态显示 */
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; }
}

/* =======================  5. 解析流水线  ======================= */
/**
 * 依据平台对源排序：平台专用源优先，其余保持注册顺序。
 * 与 Java 插件「按平台挑接口」的思路一致。
 */
function orderSources(platform) {
  if (!platform) return R.SOURCES.slice();
  const hit = R.SOURCES.filter((s) => s.supports.includes(platform));
  const rest = R.SOURCES.filter((s) => !s.supports.includes(platform));
  return [...hit, ...rest];
}

/**
 * 主解析流程：提取链接 → 依次尝试各源 → 首个成功即返回。
 * @param {string} input 用户粘贴的链接或整段文案
 * @returns {Promise<object>} 统一结果 { type, url, images, title, source, via }
 */
async function runParse(input) {
  const urls = R.extractUrls(input);
  if (!urls.length) throw new Error('没有检测到有效链接，请检查粘贴内容');
  const url = urls[0];
  const platform = R.detectPlatform(url);

  setStep(0, 'active');
  highlightChip(platform);
  pushStatus('info', `识别到${platform ? R.PLATFORM_PATTERNS[platform].name : '未知'}链接，准备解析…`);
  await sleep(280);
  setStep(0, 'done');

  const errors = [];

  /* ---------- 主通道：本地网关（服务端转发，天然无 CORS） ---------- */
  if (state.mode === 'gateway') {
    setStep(1, 'active');
    pushStatus('info', `经网关解析：${hostOf(R.GATEWAY.auto()) || '本地服务'}`);
    try {
      const j = await requestGateway(url);
      setStep(1, 'done');
      setStep(2, 'active');
      const parsed = normalizeGateway(j, platform, url);
      await sleep(200);
      setStep(2, 'done');
      setStep(3, 'active');
      await sleep(160);
      setStep(3, 'done');
      return parsed;
    } catch (e) {
      setStep(1, 'fail');
      throw new Error(
        '网关解析失败：' + e.message +
        '\n请先启动网关：cd /sdcard/Download/video-parser && python3 gateway.py' +
        '\n然后用浏览器访问 http://127.0.0.1:8787/（不要直接双击 index.html）'
      );
    }
  }

  /* ---------- 兜底旧链路：浏览器直连 / 公共代理（实测均不可用，仅调试） ---------- */
  const sources = orderSources(platform);

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];

    // 跳过缓存中已失败的源（仅本次会话）
    if (state.skipFailed && state.failedHosts.has(src.id)) continue;

    setStep(1, 'active');
    pushStatus('info', `尝试源 ${i + 1}/${sources.length}：${src.name}`);
    await sleep(180);

    try {
      const { text, via } = await requestSource(src, url);
      setStep(1, 'done');
      setStep(2, 'active');
      await sleep(200);

      const parsed = src.parse(text);
      if (!parsed) throw new Error('响应无法解析');
      parsed.source = src.name;
      parsed.via = via;
      parsed.raw = url;
      parsed.platform = platform;

      setStep(2, 'done');
      setStep(3, 'active');
      await sleep(160);
      setStep(3, 'done');
      return parsed;
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
      state.failedHosts.add(src.id);
      setStep(1, 'fail');
      setStep(2, 'fail');
      await sleep(140);
      // 继续下一个源
    }
  }

  throw new Error(
    '全部解析源均失败（浏览器直连会被 CORS 拦截）：\n' +
      errors.join('\n') +
      '\n\n请切换到「网关」模式，并启动 python3 gateway.py'
  );
}

/* =======================  6. 结果渲染  ======================= */
/** 更新一个步骤的状态：idle / active / done / fail */
function setStep(index, cls) {
  if (!state.showSteps) return;
  const el = $(`.step[data-step="${index}"]`);
  if (!el) return;
  el.classList.remove('active', 'done', 'fail');
  if (cls && cls !== 'idle') el.classList.add(cls);
}

function resetSteps() {
  $$('.step').forEach((s) => s.classList.remove('active', 'done', 'fail'));
}

/** 点亮对应平台的徽标，熄灭其它 */
function highlightChip(platform) {
  $$('.chip', els.chips).forEach((c) => {
    c.classList.toggle('on', c.dataset.p === platform);
  });
}

/** 顶部状态条 */
function pushStatus(kind, text) {
  els.status.className = 'status glass show ' + kind;
  els.statusText.textContent = text;
}

/** Toast 轻提示 */
function toast(msg, kind = 'info') {
  const icons = {
    ok: '<path d="M5 13l4 4L19 7"/>',
    err: '<path d="M6 6l12 12M18 6L6 18"/>',
    warn: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
  };
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML =
    `<svg class="t-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icons[kind] || icons.info}</svg>
     <span></span>`;
  el.lastElementChild.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 2600);
}

/** 渲染解析结果到结果卡片 */
function renderResult(r) {
  state.current = r;
  els.result.classList.add('show');

  // —— 媒体区 ——
  // 所有媒体地址都经 /api/proxy 转发：① 避免 http 直链被 https 页面的混合内容策略拦截；
  // ② 由网关补 Referer，绕过抖音/快手图片的防盗链校验。
  if (r.type === 'images') {
    els.mediaBox.style.display = 'none';
    els.galleryWrap.hidden = false;
    els.galleryWrap.innerHTML = '';
    r.images.forEach((src, i) => {
      const proxied = R.GATEWAY.media(src);
      const d = document.createElement('div');
      d.className = 'g-item';
      d.style.animationDelay = i * 40 + 'ms';
      d.innerHTML = `<img loading="lazy" alt="图${i + 1}"><span class="idx">${i + 1}</span>`;
      d.querySelector('img').src = proxied;
      d.addEventListener('click', () => openLightbox(proxied));
      els.galleryWrap.appendChild(d);
    });
  } else {
    els.galleryWrap.hidden = true;
    els.mediaBox.style.display = 'grid';
    els.mediaBox.innerHTML = '';
    const v = document.createElement('video');
    v.src = R.GATEWAY.media(r.url);
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    if (r.cover) v.poster = R.GATEWAY.media(r.cover);
    if (state.autoplay) v.autoplay = true;
    v.addEventListener('loadeddata', () => toast('视频已就绪，可播放/下载', 'ok'));
    v.addEventListener('error', () => toast('直链加载失败，可尝试新窗口打开', 'warn'));
    els.mediaBox.appendChild(v);
  }

  // —— 信息表 ——
  const rows = [
    ['来源', r.source || '-'],
    ['通道', r.via || '-'],
    ['类型', r.type === 'images' ? `图集（${r.images.length} 张）` : '视频'],
  ];
  if (r.title) rows.push(['标题', r.title]);
  rows.push(['直链', r.type === 'images' ? r.images[0] : r.url]);
  els.infoGrid.innerHTML = rows
    .map(([k, v], i) => {
      const mono = /直链/.test(k) ? ' mono' : '';
      return `<div class="info-row" style="animation-delay:${i * 50}ms">
        <span class="k">${k}</span><span class="v${mono}">${escapeHtml(v)}</span></div>`;
    })
    .join('');

  // —— 动作按钮可用性 ——
  const main = r.type === 'images' ? r.images[0] : r.url;
  els.downloadBtn.href = main;
  els.downloadBtn.download = r.type === 'images' ? 'image-1.jpg' : 'video.mp4';
  els.openBtn.onclick = () => window.open(main, '_blank', 'noopener');

  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  pushStatus('ok', `解析成功 · 来源：${r.source} · 通道：${r.via}`);
  toast('解析完成 🎉', 'ok');
}

/** 转义 HTML，防止直链里的特殊字符破坏结构 */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[c])
  );
}

/* ---------- 图片灯箱 ---------- */
function openLightbox(src) {
  els.lbImg.src = src;
  els.lightbox.classList.add('show');
}
function closeLightbox() {
  els.lightbox.classList.remove('show');
  els.lbImg.src = '';
}

/* =======================  7. 交互绑定  ======================= */
/** 主按钮：执行解析 */
async function handleParse() {
  const input = els.url.value.trim();
  if (!input) {
    toast('请先粘贴分享链接', 'warn');
    els.url.focus();
    return;
  }

  // 重置视图
  els.result.classList.remove('show');
  resetSteps();
  if (state.showSteps) els.steps.classList.add('show');
  els.parseBtn.disabled = true;
  els.parseBtn.classList.add('loading');
  els.parseBtnText.textContent = '解析中…';

  try {
    const r = await runParse(input);
    renderResult(r);
  } catch (e) {
    pushStatus('err', e.message.split('\n')[0]);
    toast('解析失败，请重试或更换链接', 'err');
    console.error('[VideoParser]', e);
    if (state.showSteps) {
      $$('.step:not(.done)').forEach((s) => s.classList.add('fail'));
    }
  } finally {
    els.parseBtn.disabled = false;
    els.parseBtn.classList.remove('loading');
    els.parseBtnText.textContent = '开始解析';
  }
}

function bindEvents() {
  /* ---- 输入框 ---- */
  els.url.addEventListener('input', () => {
    els.inputShell.classList.toggle('has-value', !!els.url.value);
    const urls = R.extractUrls(els.url.value);
    highlightChip(urls.length ? R.detectPlatform(urls[0]) : null);
  });
  els.clearBtn.addEventListener('click', () => {
    els.url.value = '';
    els.url.dispatchEvent(new Event('input'));
    els.url.focus();
  });

  /* ---- 解析 / 粘贴 ---- */
  els.parseBtn.addEventListener('click', handleParse);
  els.url.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleParse();
  });

  els.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast('剪贴板是空的', 'warn');
      els.url.value = text;
      els.url.dispatchEvent(new Event('input'));
      toast('已粘贴', 'ok');
    } catch (_) {
      toast('浏览器未授权读取剪贴板，请手动粘贴', 'warn');
      els.url.focus();
    }
  });

  /* ---- 结果动作 ---- */
  els.copyUrlBtn.addEventListener('click', async () => {
    if (!state.current) return;
    const main = state.current.type === 'images' ? state.current.images[0] : state.current.url;
    try {
      await navigator.clipboard.writeText(main);
      toast('直链已复制', 'ok');
    } catch (_) {
      toast('复制失败，请手动选择', 'warn');
    }
  });
  els.againBtn.addEventListener('click', () => {
    els.result.classList.remove('show');
    els.url.focus();
    els.url.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  /* ---- 灯箱 ---- */
  els.lbClose.addEventListener('click', closeLightbox);
  els.lightbox.addEventListener('click', (e) => {
    if (e.target === els.lightbox) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeLightbox(); closeDrawer(); }
  });

  /* ---- 主题 ---- */
  els.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  /* ---- 设置抽屉 ---- */
  els.settingsBtn.addEventListener('click', openDrawer);
  els.closeDrawer.addEventListener('click', closeDrawer);
  els.drawerMask.addEventListener('click', closeDrawer);

  els.modeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    $$('button', els.modeSeg).forEach((b) => b.classList.toggle('on', b === btn));
    els.modeLabel.textContent = { auto: '智能', direct: '直连', proxy: '代理' }[state.mode];
    saveSettings();
  });

  els.proxyPrefix.addEventListener('input', () => {
    state.proxyPrefix = els.proxyPrefix.value.trim();
    saveSettings();
  });
  els.timeout.addEventListener('input', () => {
    const v = Math.min(60000, Math.max(1000, +els.timeout.value || 15000));
    state.timeout = v;
    saveSettings();
  });
  ['autoplay', 'skipFailed', 'showSteps'].forEach((key) => {
    els[key].addEventListener('change', () => {
      state[key] = els[key].checked;
      // 关闭步骤显示时，立即收起时间线
      if (key === 'showSteps' && !state.showSteps) els.steps.classList.remove('show');
      saveSettings();
    });
  });
}

function openDrawer() {
  els.drawer.classList.add('show');
  els.drawerMask.classList.add('show');
  els.drawer.setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  els.drawer.classList.remove('show');
  els.drawerMask.classList.remove('show');
  els.drawer.setAttribute('aria-hidden', 'true');
}

/* =======================  初始化  ======================= */
function init() {
  loadSettings();
  applyTheme(localStorage.getItem('vp_theme') || 'dark');

  // 回填设置到 UI
  els.proxyPrefix.value = state.proxyPrefix || '';
  els.timeout.value = state.timeout;
  els.autoplay.checked = state.autoplay;
  els.skipFailed.checked = state.skipFailed;
  els.showSteps.checked = state.showSteps;
  $$('button', els.modeSeg).forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === state.mode)
  );

  els.apiCount.textContent = R.SOURCES.length;
  els.modeLabel.textContent = {
    gateway: '网关',
    auto: '智能（旧链路）',
    direct: '直连（调试）',
    proxy: '代理（已失效）',
  }[state.mode] || '网关';

  bindGlassHover();
  bindEvents();

  // 网关自检：让用户一眼看出“页面能打开”和“解析能用”是两件事
  checkGateway().then((ok) => {
    if (ok) {
      pushStatus('ok', '解析通道就绪 · 页面与接口同源（/api/*）');
    } else {
      const host = location.hostname;
      const local = host === '127.0.0.1' || host === 'localhost' || location.protocol === 'file:';
      pushStatus(
        'warn',
        local
          ? '未检测到本地网关（127.0.0.1:8787）。解析会全部失败，请先在项目目录执行：python3 gateway.py，'
            + '并确保本页面是从 http://127.0.0.1:8787/ 打开的，而不是双击 index.html。'
          : '未检测到 /api/health。云端部署时请确认仓库根目录存在 functions/api/*.js，'
            + '并在 Cloudflare Pages 的构建输出目录设置为项目根目录。'
      );
      toast(local ? '网关未启动：请先运行 python3 gateway.py' : '接口未部署：请检查 functions/ 目录', 'warn');
    }
  });

  pushStatus('info', '就绪 · 粘贴链接后点击「开始解析」');
  console.log('[VideoParser] 初始化完成，共', R.SOURCES.length, '个解析源，模式：', state.mode);
}

document.addEventListener('DOMContentLoaded', init);