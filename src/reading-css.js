'use strict';
/**
 * 注入番茄阅读页的「小窗阅读模式」样式。
 * 全部走 CSS 变量，运行时通过 --fr-* 调整，无需重复插入。
 */
module.exports = `
/* ===== 番茄小窗 · 阅读模式 ===== */
:root {
  --fr-fs: 19px;
  --fr-lh: 1.9;
  --fr-w: 640px;
  --fr-bg: #F7F2E9;
  --fr-fg: #33302A;
  --fr-muted: #9A9285;
}

html, body {
  background: var(--fr-bg) !important;
  overflow-x: hidden !important;
  min-width: 0 !important;
  width: 100% !important;
  max-width: 100vw !important;
}

/* 防止站点固定宽度导致小窗横向溢出 */
#app, .muye-reader, .muye-reader-inner {
  min-width: 0 !important;
  max-width: 100vw !important;
  overflow-x: hidden !important;
}

/* 隐藏站点外壳：顶栏 / 底部工具条 / 上一章下一章大按钮 / 浮层广告 */
.muye-reader-nav,
.reader-toolbar,
.muye-reader-btns,
[class*="recommend-"],
[class*="float-bar"],
[class*="download-app"],
[class*="app-guide"],
[class*="open-app"],
#root > div > div[class*="banner"] {
  display: none !important;
}

/* 布局收紧 */
.muye-reader,
.muye-reader-inner {
  background: var(--fr-bg) !important;
  padding: 0 !important;
  margin: 0 !important;
  min-height: auto !important;
}

.muye-reader-box {
  max-width: min(var(--fr-w), 100%) !important;
  width: auto !important;
  min-width: 0 !important;
  margin: 0 auto !important;
  padding: 12px 20px 72px !important;
  background: transparent !important;
  box-shadow: none !important;
  border: none !important;
}

.muye-reader-content {
  max-width: 100% !important;
  overflow-wrap: break-word !important;
}

.muye-reader-box-header {
  border: none !important;
  margin: 4px 0 10px !important;
  padding: 0 !important;
}

.muye-reader-title {
  font-size: calc(var(--fr-fs) * 1.14) !important;
  line-height: 1.5 !important;
  color: var(--fr-fg) !important;
  font-weight: 600 !important;
}

.muye-reader-subtitle {
  color: var(--fr-muted) !important;
  font-size: calc(var(--fr-fs) * 0.62) !important;
}

/* 正文排版 */
.muye-reader-content,
.muye-reader-content p,
.muye-reader-content span {
  color: var(--fr-fg) !important;
  font-size: var(--fr-fs) !important;
  line-height: var(--fr-lh) !important;
  letter-spacing: 0.015em !important;
}

.muye-reader-content p {
  margin: 0 0 0.72em !important;
  text-align: justify !important;
}

.muye-reader-content.noselect {
  user-select: text !important;
  -webkit-user-select: text !important;
}

/* 细滚动条 */
::-webkit-scrollbar { width: 6px !important; }
::-webkit-scrollbar-thumb {
  background: rgba(120, 110, 95, 0.35) !important;
  border-radius: 3px !important;
}
::-webkit-scrollbar-track { background: transparent !important; }

/* 章节锁/付费提示保留原样，仅收窄 */
[class*="lock-mask"], [class*="pay-guide"] {
  max-width: var(--fr-w) !important;
  margin: 0 auto !important;
}
`;
