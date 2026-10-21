'use strict';
/* ════════ 番茄小窗 · 壳层逻辑 ════════ */
const $ = (sel) => document.querySelector(sel);

const READER_RE = /^https?:\/\/[^/]*fanqienovel\.com\/reader\/(\d{10,25})/i;

const state = {
  settings: null,
  readingCss: '',
  books: [],
  book: null,          // 当前书籍 { id, name, author, ... }
  toc: null,           // { ids: [], titles: [], vols: [] }
  index: -1,
  ratio: 0,
  pendingRatio: 0,     // 待恢复的滚动比例
  loading: false,
  autoScrolling: false,
  nextAt: 0,           // 自动下一章的时间闸
  tocRendered: 0,
  tocFilter: '',
  loginMode: false,    // 正在登录页/登录流程中
};

const view = $('#view');
const els = {
  bookname: $('#bookname'), chapname: $('#chapname'),
  welcome: $('#welcome'), loading: $('#loading'), toast: $('#toast'),
  progBar: $('#prog-bar'), progTxt: $('#prog-txt'),
  prev: $('#btn-prev'), next: $('#btn-next'), auto: $('#btn-auto'),
  panel: $('#panel'), panelTitle: $('#panel-title'),
};

/* ─────────── 启动 ─────────── */
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

async function boot() {
  const data = await window.fr.boot();
  state.settings = data.settings;
  state.books = data.books || [];
  state.readingCss = data.readingCss || '';
  view.setAttribute('preload', data.preloadUrl);
  view.setAttribute('useragent', FALLBACK_UA);
  applyTheme(state.settings.theme);
  syncSettingsUI();
  bindEvents();

  if (data.currentBookId) {
    const book = state.books.find((b) => b.id === data.currentBookId);
    if (book) {
      try {
        const res = await window.fr.openBook(book.id, book.lastItemId);
        enterBook(res);
        return;
      } catch { /* 目录拉取失败则回退到欢迎页 */ }
    }
  }
  showWelcome();
}

/* ─────────── 主题 ─────────── */
const THEME_VARS = {
  paper:  { bg: '#F7F2E9', fg: '#33302A', muted: '#97907F' },
  kraft:  { bg: '#F3E9D6', fg: '#4A3B2A', muted: '#A08C6E' },
  night:  { bg: '#17181C', fg: '#C9C6C0', muted: '#6E6C68' },
  green:  { bg: '#E2EDE0', fg: '#2B3A2B', muted: '#7E947C' },
};

function applyTheme(t) {
  $('#app').className = `theme-${t}`;
  const v = THEME_VARS[t] || THEME_VARS.paper;
  applyReadingVars(v);
}

function applyReadingVars(v) {
  if (!state.settings) return;
  const s = state.settings;
  const theme = v || THEME_VARS[s.theme] || THEME_VARS.paper;
  const js = `(()=>{
    const r=document.documentElement.style;
    r.setProperty('--fr-fs','${s.fontSize}px');
    r.setProperty('--fr-lh','${s.lineHeight}');
    r.setProperty('--fr-w','${s.contentWidth}px');
    r.setProperty('--fr-bg','${theme.bg}');
    r.setProperty('--fr-fg','${theme.fg}');
    r.setProperty('--fr-muted','${theme.muted}');
    document.body&&(document.body.style.background='${theme.bg}');
    true; })()`;
  try { view.executeJavaScript(js).catch(() => {}); } catch { /* ignore */ }
}

/* ─────────── 打开书籍 ─────────── */
function showWelcome() {
  els.welcome.classList.remove('hidden');
  renderRecent();
  $('#open-input').focus();
}

function enterBook({ book, toc, index, books }) {
  state.book = book;
  state.toc = toc;
  state.index = index;
  state.ratio = book.ratio || 0;
  state.pendingRatio = book.ratio || 0;
  if (Array.isArray(books)) state.books = books;
  els.welcome.classList.add('hidden');
  els.bookname.textContent = book.name;
  els.bookname.title = book.name + (book.author ? ` · ${book.author}` : '');
  loadChapter(index, { ratio: book.ratio || 0 });
  if (!els.panel.classList.contains('hidden')) renderPanel();
}

async function openFromInput() {
  const input = $('#open-input').value.trim();
  const ok = await openText(input);
  if (ok) $('#open-input').value = '';
}

/** 统一的“打开/添加书籍”入口（欢迎页输入框、书架输入框共用） */
async function openText(text) {
  const input = String(text || '').trim();
  if (!input) { toast('先粘贴一个番茄链接或书籍 ID'); return false; }
  setLoading(true);
  try {
    const res = await window.fr.openInput(input);
    enterBook(res);
    toast(`已打开《${res.book.name}》`);
    return true;
  } catch (e) {
    toast('打开失败：' + (e.message || e));
    return false;
  } finally {
    setLoading(false);
  }
}

function loadChapter(index, { ratio = 0 } = {}) {
  if (!state.toc || index < 0 || index >= state.toc.ids.length) return;
  if (state.loginMode) { // 从登录页翻章 = 离开登录流程
    state.loginMode = false;
    $('#login-bar').classList.add('hidden');
  }
  state.index = index;
  state.ratio = ratio;
  state.pendingRatio = ratio;
  const id = state.toc.ids[index];
  state.loading = true;
  setLoading(true);
  try {
    view.loadURL(`https://fanqienovel.com/reader/${id}`);
  } catch (e) {
    state.loading = false;
    setLoading(false);
    toast('加载失败：' + e.message);
  }
  updateBar();
  applyAutoScroll();
  saveProgress(); // 切章立即记录进度（滚动后再持续更新）
}

function step(dir) {
  if (!state.toc) return;
  const i = state.index + dir;
  if (i < 0) { toast('已经是第一章了'); return; }
  if (i >= state.toc.ids.length) { toast('已经读到最新章节'); return; }
  loadChapter(i, { ratio: 0 });
}

function setLoading(on) {
  els.loading.classList.toggle('hidden', !on);
}

/* ─────────── 账号登录 ─────────── */
function setLoginTip(t) { $('#login-tip').textContent = t; }

async function refreshLoginStatus() {
  const el = $('#login-status');
  if (!el) return 'unknown';
  el.textContent = '检测中…';
  const st = await window.fr.loginStatus().catch(() => 'unknown');
  el.textContent = st === 'in' ? '已登录 ✓' : '未登录';
  $('#btn-logout').classList.toggle('hidden', st !== 'in');
  return st;
}

function openLoginPage() {
  state.loginMode = true;
  els.welcome.classList.add('hidden');
  $('#login-bar').classList.remove('hidden');
  // 桌面版没有独立 /login 页（404）：登录二维码就在章节页的付费提示框里，扫码即登录
  setLoginTip('用「番茄小说 App」扫描页面里的二维码登录，完成后点「返回阅读」');
  try {
    if (state.toc && state.index >= 0) {
      view.loadURL(`https://fanqienovel.com/reader/${state.toc.ids[state.index]}`);
    } else {
      view.loadURL('https://fanqienovel.com/');
    }
  } catch { /* ignore */ }
}

function backFromLogin() {
  state.loginMode = false;
  $('#login-bar').classList.add('hidden');
  refreshLoginStatus();
  if (state.toc && state.index >= 0) {
    loadChapter(state.index, { ratio: 0 }); // 重新加载当前章，带上登录态
    toast('已返回阅读');
  } else {
    showWelcome();
  }
}

async function doLogout() {
  await window.fr.logout().catch(() => {});
  refreshLoginStatus();
  toast('已退出登录（如页面仍是旧状态，翻一章即可）');
}

function updateBar() {
  const n = state.toc ? state.toc.ids.length : 0;
  const i = state.index + 1;
  els.progTxt.textContent = n ? `${i} / ${n}` : '— / —';
  els.prev.disabled = !n || state.index <= 0;
  els.next.disabled = !n || state.index >= n - 1;
  if (state.toc && state.index >= 0) {
    els.chapname.textContent = state.toc.titles[state.index] || '';
  }
}

/* ─────────── 进度保存 ─────────── */
let saveTimer = null;
function saveProgress() {
  if (!state.book || state.index < 0) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.fr.saveProgress({
      bookId: state.book.id,
      itemId: state.toc.ids[state.index],
      index: state.index,
      ratio: state.ratio,
      title: state.toc.titles[state.index] || '',
    }).catch(() => {});
  }, 700);
}

/* ─────────── webview 事件 ─────────── */
function bindView() {
  view.addEventListener('dom-ready', () => {
    const url = (view.getURL && view.getURL()) || '';
    // 只在阅读页注入小窗阅读样式，登录页等保持原样（否则二维码会被样式破坏）
    if (!state.readingCss || !READER_RE.test(url)) return;
    try {
      view.insertCSS(state.readingCss);
    } catch { /* ignore */ }
    applyReadingVars();
  });

  view.addEventListener('did-finish-load', () => {
    state.loading = false;
    setLoading(false);
    // 付费墙提示：部分书网页端需官方 App / SVIP 才能看全文（只提示一次）
    const u0 = (view.getURL && view.getURL()) || '';
    if (READER_RE.test(u0)) {
      setTimeout(() => {
        view.executeJavaScript("document.body.innerText.includes('扫码下载APP免费读')||document.body.innerText.includes('SVIP网页畅读')")
          .then((hit) => { if (hit) toast('本章网页端受限：这本书需要番茄 App（免费）或 SVIP 才能看全文'); })
          .catch(() => {});
      }, 1500);
    }
    // 恢复滚动位置
    if (state.pendingRatio > 0.005) {
      const r = state.pendingRatio;
      state.pendingRatio = 0;
      setTimeout(() => {
        try { view.send('fr-cmd', { type: 'scroll-to', ratio: r }); } catch { /* ignore */ }
      }, 900);
    }
    applyAutoScroll();
  });

  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // 用户取消
    state.loading = false;
    setLoading(false);
    toast('页面加载失败（' + e.errorDescription + '）');
  });

  view.addEventListener('did-navigate', () => syncFromUrl());
  view.addEventListener('did-navigate-in-page', () => syncFromUrl());

  view.addEventListener('ipc-message', (e) => {
    if (e.channel !== 'fr') return;
    const m = e.args && e.args[0];
    if (!m) return;
    if (m.type === 'scroll') {
      state.ratio = m.ratio || 0;
      els.progBar.style.width = `${Math.round(state.ratio * 100)}%`;
      saveProgress();
      if (
        state.settings.autoNext && state.ratio > 0.985 &&
        Date.now() > state.nextAt && state.index >= 0 &&
        state.toc && state.index < state.toc.ids.length - 1
      ) {
        state.nextAt = Date.now() + 4000;
        step(1);
      }
    } else if (m.type === 'chapter' && m.title) {
      els.chapname.textContent = m.title;
      if (state.index >= 0 && state.toc) {
        state.toc.titles[state.index] = m.title;
      }
    } else if (m.type === 'key') {
      if (m.key === 'ArrowLeft') step(-1);
      if (m.key === 'ArrowRight') step(1);
    }
  });

  view.addEventListener('render-process-gone', () => {
    try { view.reload(); } catch { /* ignore */ }
  });
}

function syncFromUrl() {
  const url = view.getURL ? view.getURL() : '';
  const m = url.match(READER_RE);
  if (m && state.toc) {
    const i = state.toc.ids.indexOf(m[1]);
    if (i >= 0 && i !== state.index) {
      state.index = i;
      updateBar();
      saveProgress();
    }
  } else if (m && !state.toc) {
    els.chapname.textContent = '';
  } else if (!m && /^https?:/.test(url)) {
    // 只有真正离开了阅读页才提示（about:blank 等空白页不打扰）
    els.chapname.textContent = '当前不在阅读页';
  }
}

/* ─────────── 自动滚动 ─────────── */
function applyAutoScroll() {
  const on = state.settings.autoScroll && !state.loading;
  state.autoScrolling = on;
  els.auto.classList.toggle('on', on);
  $('#ic-play').classList.toggle('hidden', on);
  $('#ic-pause').classList.toggle('hidden', !on);
  const speed = Number(state.settings.scrollSpeed) || 1;
  try {
    view.executeJavaScript(`(()=>{
      if(window.__frScrollTimer){clearInterval(window.__frScrollTimer);window.__frScrollTimer=null;}
      ${on ? `window.__frScrollTimer=setInterval(()=>{
        const el=document.scrollingElement||document.documentElement;
        el.scrollTop+=${(speed * 0.55).toFixed(2)};
      },16);` : ''}
      true; })()`).catch(() => {});
  } catch { /* ignore */ }
}

function toggleAutoScroll() {
  state.settings.autoScroll = !state.settings.autoScroll;
  window.fr.setSettings({ autoScroll: state.settings.autoScroll });
  $('#s-auto').checked = state.settings.autoScroll;
  applyAutoScroll();
  toast(state.settings.autoScroll ? '自动滚动已开启' : '自动滚动已暂停');
}

/* ─────────── 侧滑面板 ─────────── */
function showPanel(which) {
  const p = els.panel;
  if (!which) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  els.panelTitle.textContent = { toc: '目录', shelf: '书架', set: '设置' }[which];
  for (const id of ['toc', 'shelf', 'set']) {
    $(`#sec-${id}`).classList.toggle('hidden', id !== which);
  }
  if (which === 'toc') renderToc(true);
  if (which === 'shelf') {
    renderShelf();
    // 书架为空时把光标放到输入框，直接粘贴即可添加
    if (!state.books.length) setTimeout(() => $('#shelf-input').focus(), 120);
  }
  if (which === 'set') refreshLoginStatus();
}

function renderPanel() {
  // 面板开着时刷新内容
  if (els.panel.classList.contains('hidden')) return;
  if (!$('#sec-toc').classList.contains('hidden')) renderToc(true);
  if (!$('#sec-shelf').classList.contains('hidden')) renderShelf();
}

/* 目录（分块渲染 + 过滤） */
const CHUNK = 300;
function renderToc(reset) {
  if (!state.toc) return;
  const list = $('#toc-list');
  if (reset) { list.innerHTML = ''; state.tocRendered = 0; }
  const f = state.tocFilter.trim().toLowerCase();
  let items;
  if (f) {
    items = [];
    state.toc.titles.forEach((t, i) => {
      if (t.toLowerCase().includes(f)) items.push(i);
    });
    if (reset) {
      list.innerHTML = '';
      items.slice(0, CHUNK).forEach((i) => appendTocItem(list, i, items.length));
      state.tocRendered = Math.min(CHUNK, items.length);
      state._filtered = items;
      if (!items.length) list.innerHTML = '<div class="t-vol">没有匹配的章节</div>';
    } else {
      const from = state.tocRendered;
      (state._filtered || []).slice(from, from + CHUNK).forEach((i) => appendTocItem(list, i, items.length));
      state.tocRendered = Math.min(from + CHUNK, (state._filtered || []).length);
    }
    return;
  }
  state._filtered = null;
  const total = state.toc.ids.length;
  const from = reset ? 0 : state.tocRendered;
  const to = Math.min(from + CHUNK, total);
  if (reset) list.innerHTML = '';
  let lastVol = null;
  for (let i = from; i < to; i++) {
    const vol = state.toc.vols[i];
    if (vol && vol !== lastVol && i > 0) {
      const d = document.createElement('div');
      d.className = 't-vol';
      d.textContent = vol;
      list.appendChild(d);
    }
    if (vol) lastVol = vol;
    appendTocItem(list, i, total);
  }
  state.tocRendered = to;
}

function appendTocItem(list, i, total) {
  const cur = i === state.index;
  const d = document.createElement('div');
  d.className = 't-item' + (cur ? ' cur' : '');
  d.dataset.idx = i;
  const vol = state.toc.vols[i] ? `${state.toc.vols[i]} · ` : '';
  d.innerHTML = `<span class="t-idx">${i + 1}</span><span class="t-name"></span>`;
  d.querySelector('.t-name').textContent = `${vol}${state.toc.titles[i] || `第${i + 1}章`}`;
  d.addEventListener('click', () => {
    loadChapter(i, { ratio: 0 });
    showPanel(null);
  });
  list.appendChild(d);
  if (cur && state.tocRendered > i) {
    setTimeout(() => d.scrollIntoView({ block: 'center' }), 30);
  }
}

/* 书架 */
const COVER_COLORS = ['#E8543C', '#C25E33', '#3F8F5A', '#4A6FA5', '#8E5BA6', '#B0483F', '#2E8B8B', '#A8683C'];
function coverColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}

function renderShelf() {
  const list = $('#shelf-list');
  list.innerHTML = '';
  if (!state.books.length) {
    list.innerHTML = '<div class="t-vol" style="padding:20px 8px;text-align:center">书架空空的，粘贴链接添加第一本吧</div>';
    return;
  }
  state.books.forEach((b) => {
    const d = document.createElement('div');
    d.className = 'r-item';
    d.innerHTML = `
      <div class="r-cover" style="background:${coverColor(b.id)}">书</div>
      <div class="r-info">
        <div class="r-name"></div>
        <div class="r-chap"></div>
      </div>
      <button class="r-del" title="移出书架">✕</button>`;
    d.querySelector('.r-name').textContent = b.name || `书籍 ${b.id}`;
    d.querySelector('.r-chap').textContent = b.title ? `读到 ${b.title}` : '刚开始读';
    d.addEventListener('click', async (e) => {
      if (e.target.classList.contains('r-del')) return;
      setLoading(true);
      try {
        enterBook(await window.fr.openBook(b.id, b.lastItemId));
        showPanel(null);
      } catch (err) {
        toast('打开失败：' + (err.message || err));
      } finally {
        setLoading(false);
      }
    });
    d.querySelector('.r-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`把《${b.name || b.id}》移出书架？`)) return;
      state.books = await window.fr.removeBook(b.id);
      if (state.book && state.book.id === b.id) {
        state.book = null; state.toc = null; state.index = -1;
        els.bookname.textContent = '未选择书籍';
        els.chapname.textContent = '粘贴番茄小说链接或 ID 开始';
        els.progTxt.textContent = '— / —';
        els.progBar.style.width = '0%';
        try { view.stop(); view.loadURL('about:blank'); } catch { /* ignore */ }
        showWelcome();
      }
      renderShelf();
      toast('已移出书架');
    });
    list.appendChild(d);
  });
}

function renderRecent() {
  const list = $('#recent-list');
  list.innerHTML = '';
  if (!state.books.length) {
    list.innerHTML = '<div class="t-vol" style="padding:6px 2px">还没有记录</div>';
    return;
  }
  state.books.slice(0, 6).forEach((b) => {
    const d = document.createElement('div');
    d.className = 'r-item';
    d.innerHTML = `
      <div class="r-cover" style="background:${coverColor(b.id)}">书</div>
      <div class="r-info"><div class="r-name"></div><div class="r-chap"></div></div>`;
    d.querySelector('.r-name').textContent = b.name || `书籍 ${b.id}`;
    d.querySelector('.r-chap').textContent = b.title ? `读到 ${b.title}` : '刚开始读';
    d.addEventListener('click', async () => {
      setLoading(true);
      try {
        enterBook(await window.fr.openBook(b.id, b.lastItemId));
      } catch (err) {
        toast('打开失败：' + (err.message || err));
      } finally {
        setLoading(false);
      }
    });
    list.appendChild(d);
  });
}

/* ─────────── 设置面板同步 ─────────── */
function syncSettingsUI() {
  const s = state.settings;
  $('#theme-chips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
  $('#s-fs').value = s.fontSize;   $('#v-fs').textContent = s.fontSize;
  $('#s-lh').value = s.lineHeight; $('#v-lh').textContent = Number(s.lineHeight).toFixed(2);
  $('#s-w').value = s.contentWidth; $('#v-w').textContent = s.contentWidth;
  $('#s-op').value = Math.round(s.opacity * 100); $('#v-op').textContent = Math.round(s.opacity * 100) + '%';
  $('#s-top').checked = s.alwaysOnTop;
  $('#s-pierce').checked = s.pierce;
  $('#s-auto').checked = s.autoScroll;
  $('#s-speed').value = s.scrollSpeed; $('#v-speed').textContent = s.scrollSpeed + '×';
  $('#s-autonext').checked = s.autoNext;
}

function bindEvents() {
  /* 标题栏 */
  $('#btn-hide').addEventListener('click', () => window.fr.hideWindow());
  $('#btn-quit').addEventListener('click', () => window.fr.quitApp());
  $('#btn-toc').addEventListener('click', () => {
    const open = !els.panel.classList.contains('hidden') && !$('#sec-toc').classList.contains('hidden');
    showPanel(open ? null : 'toc');
  });
  $('#btn-shelf').addEventListener('click', () => {
    const open = !els.panel.classList.contains('hidden') && !$('#sec-shelf').classList.contains('hidden');
    showPanel(open ? null : 'shelf');
  });
  $('#btn-set').addEventListener('click', () => {
    const open = !els.panel.classList.contains('hidden') && !$('#sec-set').classList.contains('hidden');
    showPanel(open ? null : 'set');
  });
  $('#panel-close').addEventListener('click', () => showPanel(null));
  $('#panel-mask').addEventListener('click', () => showPanel(null));

  /* 打开输入 */
  $('#open-btn').addEventListener('click', openFromInput);
  $('#open-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') openFromInput(); });

  /* 书架内添加新书 */
  const addFromShelf = async () => {
    const el = $('#shelf-input');
    const ok = await openText(el.value);
    if (ok) {
      el.value = '';
      renderShelf();
      showPanel(null);
    }
  };
  $('#shelf-add').addEventListener('click', addFromShelf);
  $('#shelf-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFromShelf(); });

  /* 底栏 */
  els.prev.addEventListener('click', () => step(-1));
  els.next.addEventListener('click', () => step(1));
  els.auto.addEventListener('click', toggleAutoScroll);
  $('#bottombar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.nav')) return;
    toggleAutoScroll();
  });

  /* 目录过滤 */
  $('#toc-filter').addEventListener('input', (e) => {
    state.tocFilter = e.target.value;
    renderToc(true);
  });
  $('#toc-list').addEventListener('scroll', () => {
    const l = $('#toc-list');
    if (l.scrollTop + l.clientHeight > l.scrollHeight - 60) renderToc(false);
  });

  /* 设置项 */
  $('#theme-chips').addEventListener('click', (e) => {
    const t = e.target.dataset && e.target.dataset.theme;
    if (!t) return;
    state.settings.theme = t;
    window.fr.setSettings({ theme: t });
    applyTheme(t);
    syncSettingsUI();
  });
  const bindRange = (sel, key, fmt, apply) => {
    $(sel).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      state.settings[key] = v;
      fmt(v);
      apply(v);
    });
    $(sel).addEventListener('change', () => window.fr.setSettings({ [key]: state.settings[key] }));
  };
  bindRange('#s-fs', 'fontSize', (v) => { $('#v-fs').textContent = v; }, () => applyReadingVars());
  bindRange('#s-lh', 'lineHeight', (v) => { $('#v-lh').textContent = v.toFixed(2); }, () => applyReadingVars());
  bindRange('#s-w', 'contentWidth', (v) => { $('#v-w').textContent = v; }, () => applyReadingVars());
  bindRange('#s-op', 'opacity', (v) => { $('#v-op').textContent = v + '%'; }, () => {
    window.fr.setSettings({ opacity: state.settings.opacity });
  });
  $('#s-speed').addEventListener('input', (e) => {
    state.settings.scrollSpeed = Number(e.target.value);
    $('#v-speed').textContent = state.settings.scrollSpeed + '×';
    applyAutoScroll();
  });
  $('#s-speed').addEventListener('change', () => window.fr.setSettings({ scrollSpeed: state.settings.scrollSpeed }));
  $('#s-top').addEventListener('change', (e) => window.fr.setSettings({ alwaysOnTop: e.target.checked }));
  $('#s-pierce').addEventListener('change', (e) => window.fr.setSettings({ pierce: e.target.checked }));
  $('#s-auto').addEventListener('change', (e) => {
    state.settings.autoScroll = e.target.checked;
    applyAutoScroll();
    window.fr.setSettings({ autoScroll: state.settings.autoScroll });
  });
  $('#s-autonext').addEventListener('change', (e) => window.fr.setSettings({ autoNext: e.target.checked }));

  $('#size-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) window.fr.resizeWindow(Number(b.dataset.w), Number(b.dataset.h));
  });

  $('#btn-external').addEventListener('click', () => {
    if (state.toc && state.index >= 0) {
      window.fr.openExternal(`https://fanqienovel.com/reader/${state.toc.ids[state.index]}`);
    } else {
      window.fr.openExternal('https://fanqienovel.com');
    }
  });

  /* 账号登录 */
  $('#btn-login').addEventListener('click', () => {
    showPanel(null);
    openLoginPage();
  });
  $('#btn-logout').addEventListener('click', doLogout);
  $('#login-back').addEventListener('click', backFromLogin);

  /* 壳层键盘 */
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') showPanel(null);
    else if (e.key === 'F9') toggleAutoScroll();
  });

  window.fr.onSettingsChanged((s) => {
    state.settings = s;
    syncSettingsUI();
  });

  // 命令行 --open=xxx 直接打开书籍
  window.fr.onOpenRequest((text) => {
    $('#open-input').value = text;
    openFromInput();
  });
}

/* ─────────── 工具 ─────────── */
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2400);
}

/* ─────────── 入口 ─────────── */
bindView();   // 先挂好监听，再启动（保证首个 dom-ready 也能收到 CSS 注入）
boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:20px;font-size:12px">启动失败：${e.stack || e}</pre>`;
});
