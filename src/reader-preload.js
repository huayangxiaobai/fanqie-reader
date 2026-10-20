'use strict';
/**
 * 注入到番茄阅读页的 preload（guest）。
 * 通过 ipcRenderer.sendToHost 向壳层推送：滚动比例、到达底部、按键、章节标题。
 */
const { ipcRenderer } = require('electron');

const send = (type, payload) => {
  try { ipcRenderer.sendToHost('fr', { type, ...(payload || {}) }); } catch { /* ignore */ }
};

function scroller() {
  return document.scrollingElement || document.documentElement;
}

function scrollRatio() {
  const el = scroller();
  const max = el.scrollHeight - el.clientHeight;
  return max > 4 ? Math.min(1, el.scrollTop / max) : 0;
}

/* ---- 滚动上报（捕获阶段，容器内滚动也能收到） ---- */
let lastTick = 0;
window.addEventListener('scroll', (e) => {
  const now = Date.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  const target = e.target;
  let ratio;
  if (target === document || target === document.documentElement || target === window) {
    ratio = scrollRatio();
  } else if (target && typeof target.scrollTop === 'number' && target.scrollHeight > target.clientHeight + 4) {
    const max = target.scrollHeight - target.clientHeight;
    ratio = Math.min(1, target.scrollTop / max);
  } else {
    ratio = scrollRatio();
  }
  send('scroll', { ratio });
}, { capture: true, passive: true });

/* ---- 按键转发（壳层用于左右方向键切章） ---- */
window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'F9') {
    send('key', { key: k, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey });
  }
}, { capture: true });

/* ---- 章节信息与就绪上报 ---- */
function reportChapter() {
  const titleEl = document.querySelector('.muye-reader-title');
  send('chapter', { title: titleEl ? titleEl.textContent.trim() : document.title.split('在线免费阅读')[0] });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(reportChapter, 400));
} else {
  setTimeout(reportChapter, 400);
}

/* ---- 壳层下发的指令：恢复滚动位置 ---- */
ipcRenderer.on('fr-cmd', (_e, cmd) => {
  try {
    if (cmd && cmd.type === 'scroll-to') {
      const el = scroller();
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, max * (cmd.ratio || 0));
    }
  } catch { /* ignore */ }
});
