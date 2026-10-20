'use strict';
/**
 * 番茄小窗 —— 主进程
 * 负责：无边框小窗、托盘、全局老板键、目录抓取、进度与配置持久化
 */
const {
  app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu,
  nativeImage, shell, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const IS_DEV = process.argv.includes('--dev');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const SITE = 'https://fanqienovel.com';

// 小窗以文本阅读为主，禁用硬件加速以兼容无 GPU / 远程桌面环境
app.disableHardwareAcceleration();

// 渲染进程反复崩溃（个别环境 sandbox/GPU 受限）→ 自动以兼容参数重启
let rendererCrashes = 0;
app.on('render-process-gone', (_e, _wc, details) => {
  rendererCrashes += 1;
  console.error('[renderer-gone]', details && details.reason, details && details.exitCode);
  if (rendererCrashes >= 2 && !process.argv.includes('--no-sandbox')) {
    const args = process.argv.slice(1).filter((a) => a !== '--dev');
    if (!args.includes('--no-sandbox')) args.push('--no-sandbox');
    if (!args.includes('--disable-gpu')) args.push('--disable-gpu');
    console.warn('[fallback] relaunching with', args.join(' '));
    // 派生新实例并带上 FQ_FALLBACK 标记（新实例会先等待旧实例释放锁）
    // 注意：Windows 环境变量大小写重复（如 HTTPS_PROXY/https_proxy）会导致子进程创建失败，需去重
    const env = { ...process.env };
    const seen = new Set();
    for (const k of Object.keys(env)) {
      const low = k.toLowerCase();
      if (seen.has(low)) delete env[k];
      else seen.add(low);
    }
    env.FQ_FALLBACK = '1';
    try {
      const out = fs.openSync(path.join(USER_DIR(), 'fallback.log'), 'a');
      const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env });
      child.on('error', (e) => console.error('[fallback] child error:', e));
      child.on('exit', (code) => console.warn('[fallback] child exited:', code));
      child.unref();
      console.warn('[fallback] child spawned pid=', child.pid);
    } catch (e) {
      console.error('[fallback] spawn failed:', e);
    }
    app.exit(0);
  }
});

/* ------------------------------------------------------------------ *
 * 持久化存储
 * ------------------------------------------------------------------ */
const USER_DIR = () => app.getPath('userData');
const CONFIG_FILE = () => path.join(USER_DIR(), 'config.json');
const TOC_DIR = () => path.join(USER_DIR(), 'toc');

const DEFAULTS = {
  version: 1,
  settings: {
    theme: 'paper',      // paper | kraft | night | green
    fontSize: 19,
    lineHeight: 1.9,
    contentWidth: 640,
    opacity: 1,
    alwaysOnTop: true,
    pierce: false,
    autoScroll: false,
    scrollSpeed: 1,
    autoNext: true,
    bounds: { width: 420, height: 660, x: null, y: null },
  },
  books: [],             // [{ id, name, author, lastItemId, lastIndex, ratio, title, updatedAt }]
  currentBookId: null,
};

let store = loadStore();

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf-8'));
    return {
      ...DEFAULTS,
      ...raw,
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

let saveTimer = null;
function saveStore(immediate = false) {
  const write = () => {
    try {
      fs.mkdirSync(USER_DIR(), { recursive: true });
      const tmp = CONFIG_FILE() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
      fs.renameSync(tmp, CONFIG_FILE());
    } catch (e) {
      console.error('[store] save failed:', e);
    }
  };
  clearTimeout(saveTimer);
  if (immediate) write();
  else saveTimer = setTimeout(write, 400);
}

function loadToc(bookId) {
  try {
    const p = path.join(TOC_DIR(), `${bookId}.json`);
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - data.fetchedAt < 12 * 3600 * 1000) return data;
  } catch { /* ignore */ }
  return null;
}

function writeToc(bookId, toc) {
  try {
    fs.mkdirSync(TOC_DIR(), { recursive: true });
    toc.fetchedAt = Date.now();
    fs.writeFileSync(path.join(TOC_DIR(), `${bookId}.json`), JSON.stringify(toc), 'utf-8');
  } catch (e) {
    console.error('[toc] write failed:', e);
  }
}

/* ------------------------------------------------------------------ *
 * 番茄站点数据抓取
 * ------------------------------------------------------------------ */
function parseInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const urlM = s.match(/https?:\/\/[^\s"'<>，,。]+/);
  const text = urlM ? urlM[0] : s;
  let m = text.match(/fanqienovel\.com\/(?:page|reader)\/(\d{10,25})/i);
  if (m) return { kind: /\/reader\//i.test(text) ? 'item' : 'book', id: m[1] };
  m = text.match(/[?&](?:book_?id|bookId|content_?id)=(\d{10,25})/i);
  if (m) return { kind: 'book', id: m[1] };
  m = s.match(/(\d{15,25})/);
  if (m) return { kind: 'book', id: m[1] };
  // 站内分享短链（changdunovel.com/t/xxxx、fqnovel.com/xxx 等）：需要展开重定向后取 book_id
  if (/^https?:\/\//i.test(text) &&
      /(?:changdunovel|fqnovel|fanqienovel|novel)\.(?:com|cn)/i.test(text)) {
    return { kind: 'short', url: text };
  }
  return null;
}

/* 展开分享短链：跟随 30x 跳转，或从落地页 HTML 中提取 book_id */
async function expandShortLink(startUrl) {
  let cur = startUrl;
  for (let hop = 0; hop < 8; hop++) {
    let res;
    try {
      res = await fetch(cur, {
        redirect: 'manual',
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Error('短链打不开（网络异常）：' + (e.message || e));
    }
    const loc = res.headers.get('location');
    if (loc && res.status >= 300 && res.status < 400) {
      cur = new URL(loc, cur).href;
      const hit = parseInput(cur);
      if (hit && hit.id) return hit;
      continue;
    }
    const html = await res.text().catch(() => '');
    let m = html.match(/[?&"'](?:book_?id|bookId)["'=:&\s]{1,8}(\d{10,25})/i)
         || html.match(/"bookId"\s*:\s*"?(\d{10,25})/);
    if (m) return { kind: 'book', id: m[1] };
    m = html.match(/fanqienovel\.com\/page\/(\d{10,25})/);
    if (m) return { kind: 'book', id: m[1] };
    break;
  }
  return null;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: SITE + '/', 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 通过目录接口取章节列表（含卷名） */
async function fetchToc(bookId) {
  const cached = loadToc(bookId);
  if (cached) return cached;
  const html = await fetchText(`${SITE}/api/reader/directory/detail?bookId=${bookId}`);
  const json = JSON.parse(html);
  const data = json && json.data ? json.data : {};
  const vols = data.chapterListWithVolume || [];
  const titles = [];
  const ids = [];
  const volNames = [];
  const volList = data.volumeNameList && data.volumeNameList.length ? data.volumeNameList : vols.map(() => '正文');
  vols.forEach((chapters, vi) => {
    (chapters || []).forEach((c) => {
      ids.push(String(c.itemId));
      titles.push(String(c.title || '').trim());
      volNames.push(String(volList[vi] || '正文'));
    });
  });
  if (!ids.length) throw new Error('目录为空，书籍可能不存在或已下架');
  const toc = { bookId, ids, titles, vols: volNames };
  writeToc(bookId, toc);
  return toc;
}

/** 书籍元信息（书名/作者） */
async function fetchBookMeta(bookId) {
  try {
    const html = await fetchText(`${SITE}/page/${bookId}`);
    const h1 = html.match(/<h1[^>]*>([^<]{1,80})<\/h1>/);
    const author = html.match(/"author":"([^"]{1,40})"/);
    const desc = html.match(/<meta name="description" content="([^"]{1,120})/);
    return {
      name: (h1 && h1[1].trim()) || `书籍 ${bookId}`,
      author: author ? author[1].trim() : '',
      desc: desc ? desc[1].trim() : '',
    };
  } catch {
    return { name: `书籍 ${bookId}`, author: '', desc: '' };
  }
}

/** itemId → bookId（阅读页内嵌 bookId 字段） */
async function resolveBookId(itemId) {
  const html = await fetchText(`${SITE}/reader/${itemId}`);
  const m = html.match(/"bookId":"(\d{10,25})"/);
  if (m) return m[1];
  const m2 = html.match(/book_id[=/](\d{10,25})/i);
  if (m2) return m2[1];
  throw new Error('无法从链接解析书籍 ID');
}

/* ------------------------------------------------------------------ *
 * 主窗口
 * ------------------------------------------------------------------ */
let win = null;
let tray = null;
let quiting = false;

function createWindow() {
  const b = store.settings.bounds || {};
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(b.width || 420, area.width),
    height: Math.min(b.height || 660, area.height),
    x: Number.isFinite(b.x) ? Math.max(b.x, area.x - 40) : area.x + area.width - 460,
    y: Number.isFinite(b.y) ? Math.max(b.y, area.y - 20) : area.y + 60,
    minWidth: 280,
    minHeight: 220,
    frame: false,
    backgroundColor: '#F7F2E9',
    show: false,
    skipTaskbar: true,
    resizable: true,
    fullscreenable: false,
    maximizable: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  applyAlwaysOnTop();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 命令行直接打开书籍：electron . --open=<链接或ID>
  const openArg = process.argv.find((a) => a.startsWith('--open='));
  if (openArg) {
    const target = openArg.slice('--open='.length);
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        try { win.webContents.send('open-request', target); } catch { /* ignore */ }
      }, 1200);
    });
  }

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      store.settings.bounds = win.getBounds();
      saveStore();
    }, 600);
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);
  win.on('close', (e) => {
    if (!quiting) {
      e.preventDefault();
      win.hide(); // 点 × 也只是收进托盘/老板键唤起
    }
  });
  win.on('closed', () => { win = null; });
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

function applyAlwaysOnTop() {
  if (!win) return;
  win.setAlwaysOnTop(Boolean(store.settings.alwaysOnTop), 'floating');
}

function applyOpacity() {
  if (!win) return;
  win.setOpacity(Math.min(1, Math.max(0.25, Number(store.settings.opacity) || 1)));
}

function applyPierce() {
  if (!win) return;
  win.setIgnoreMouseEvents(Boolean(store.settings.pierce), { forward: true });
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('番茄小窗');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏（Alt+X）', click: toggleVisible },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: !!store.settings.alwaysOnTop, click: (i) => setSetting('alwaysOnTop', i.checked) },
    { label: '鼠标穿透（Alt+V）', type: 'checkbox', checked: !!store.settings.pierce, click: (i) => setSetting('pierce', i.checked) },
    { type: 'separator' },
    { label: '尺寸：紧凑 320×520', click: () => resizeTo(320, 520) },
    { label: '尺寸：标准 420×660', click: () => resizeTo(420, 660) },
    { label: '尺寸：宽松 560×800', click: () => resizeTo(560, 800) },
    { type: 'separator' },
    { label: '打开番茄官网', click: () => shell.openExternal(SITE) },
    { label: '退出', click: () => { quiting = true; app.quit(); } },
  ]));
  tray.on('click', toggleVisible);
}

function resizeTo(w, h) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: w, height: h });
}

function setSetting(key, value) {
  store.settings[key] = value;
  saveStore();
  if (key === 'alwaysOnTop') applyAlwaysOnTop();
  if (key === 'opacity') applyOpacity();
  if (key === 'pierce') applyPierce();
  if (win && !win.isDestroyed()) win.webContents.send('settings-changed', store.settings);
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('boot', () => ({
    settings: store.settings,
    books: store.books,
    currentBookId: store.currentBookId,
    preloadUrl: pathToFileURL(path.join(__dirname, 'reader-preload.js')).href,
    readingCss: (fs.readFileSync(path.join(__dirname, 'reading-css.js'), 'utf-8')
      .match(/module\.exports\s*=\s*`([\s\S]*)`/) || ['', ''])[1],
    isDev: IS_DEV,
  }));

  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(store.settings, patch || {});
    saveStore();
    for (const k of ['alwaysOnTop', 'opacity', 'pierce']) {
      if (k in (patch || {})) {
        if (k === 'alwaysOnTop') applyAlwaysOnTop();
        if (k === 'opacity') applyOpacity();
        if (k === 'pierce') applyPierce();
      }
    }
    return store.settings;
  });

  ipcMain.handle('book:open', async (_e, input) => {
    let entry = parseInput(input);
    if (!entry) throw new Error('没有识别到有效的番茄链接或书籍 ID');
    if (entry.kind === 'short') {
      entry = await expandShortLink(entry.url);
      if (!entry) throw new Error('分享链接已失效，或不是番茄小说的书籍链接');
    }
    let bookId = entry.id;
    if (entry.kind === 'book') {
      // 纯数字可能是章节 itemId：目录为空则按 itemId 解析
      try {
        const toc = await fetchToc(bookId);
        return await buildOpenResult(bookId, toc, null);
      } catch (err) {
        bookId = await resolveBookId(bookId);
        const toc = await fetchToc(bookId);
        return await buildOpenResult(bookId, toc, entry.id === bookId ? null : entry.id);
      }
    }
    bookId = await resolveBookId(entry.id);
    const toc = await fetchToc(bookId);
    return await buildOpenResult(bookId, toc, entry.id);
  });

  ipcMain.handle('book:openId', async (_e, bookId, itemId) => {
    const toc = await fetchToc(String(bookId));
    return await buildOpenResult(String(bookId), toc, itemId || null);
  });

  ipcMain.handle('toc:refresh', async (_e, bookId) => {
    try { fs.unlinkSync(path.join(TOC_DIR(), `${bookId}.json`)); } catch { /* ignore */ }
    const toc = await fetchToc(String(bookId));
    return toc;
  });

  ipcMain.handle('progress:save', (_e, payload) => {
    const { bookId, itemId, index, ratio, title } = payload || {};
    let book = store.books.find((b) => b.id === String(bookId));
    if (!book) return false;
    book.lastItemId = String(itemId);
    book.lastIndex = index;
    book.ratio = ratio || 0;
    if (title) book.title = title;
    book.updatedAt = Date.now();
    store.books.sort((a, b) => b.updatedAt - a.updatedAt);
    store.currentBookId = String(bookId);
    saveStore();
    return true;
  });

  ipcMain.handle('book:remove', (_e, bookId) => {
    store.books = store.books.filter((b) => b.id !== String(bookId));
    if (store.currentBookId === String(bookId)) store.currentBookId = null;
    saveStore(true);
    try { fs.unlinkSync(path.join(TOC_DIR(), `${bookId}.json`)); } catch { /* ignore */ }
    return store.books;
  });

  ipcMain.handle('external:open', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url));
  });

  ipcMain.handle('win:hide', () => win && win.hide());
  ipcMain.handle('win:close', () => { quiting = true; app.quit(); });
  ipcMain.handle('win:pierce', (_e, on) => setSetting('pierce', Boolean(on)));
  ipcMain.handle('win:resize', (_e, w, h) => resizeTo(w, h));
}

async function buildOpenResult(bookId, toc, openItemId) {
  let book = store.books.find((b) => b.id === bookId);
  if (!book) {
    const meta = await fetchBookMeta(bookId);
    book = {
      id: bookId, name: meta.name, author: meta.author, desc: meta.desc,
      lastItemId: toc.ids[0], lastIndex: 0, ratio: 0, title: toc.titles[0] || '',
      updatedAt: Date.now(),
    };
    store.books.unshift(book);
  }
  book.updatedAt = book.updatedAt || Date.now();
  store.currentBookId = bookId;
  saveStore();
  let index = book.lastIndex || 0;
  if (openItemId) {
    const i = toc.ids.indexOf(String(openItemId));
    if (i >= 0) index = i;
  }
  if (index >= toc.ids.length) index = 0;
  return { book, toc, index, books: store.books };
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
// 回退重启场景：先等旧实例退出并释放单实例锁
if (process.env.FQ_FALLBACK) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); } catch { /* ignore */ }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.userAgentFallback = UA;

  app.whenReady().then(() => {
    createWindow();
    createTray();
    registerIpc();

    // 全局快捷键：老板键 + 鼠标穿透
    const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch (e) { console.error('[shortcut]', acc, e); } };
    reg('Alt+X', toggleVisible);
    reg('Alt+V', () => setSetting('pierce', !store.settings.pierce));
    reg('Alt+C', () => setSetting('alwaysOnTop', !store.settings.alwaysOnTop));

    // webview 里的新窗口/外链 → 系统浏览器
    app.on('web-contents-created', (_e, contents) => {
      if (contents.getType() === 'webview') {
        contents.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\//.test(url)) shell.openExternal(url);
          return { action: 'deny' };
        });
        contents.on('will-navigate', (e, url) => {
          if (!/^https?:\/\/([^/]*\.)?(fanqienovel\.com|fqnovel\.com|toutiao\.com|bytedance\.com|zjzwapi\.com)/i.test(url)) {
            e.preventDefault();
            shell.openExternal(url);
          }
        });
      }
    });
  });

  app.on('before-quit', () => {
    quiting = true;
    saveStore(true);
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不随窗口关闭退出
  });
}
