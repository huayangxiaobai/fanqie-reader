'use strict';
/** 壳 UI 的 preload：白名单 API 暴露给渲染进程 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fr', {
  boot: () => ipcRenderer.invoke('boot'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openInput: (text) => ipcRenderer.invoke('book:open', text),
  openBook: (bookId, itemId) => ipcRenderer.invoke('book:openId', bookId, itemId),
  refreshToc: (bookId) => ipcRenderer.invoke('toc:refresh', bookId),
  saveProgress: (p) => ipcRenderer.invoke('progress:save', p),
  removeBook: (bookId) => ipcRenderer.invoke('book:remove', bookId),
  loginStatus: () => ipcRenderer.invoke('login:status'),
  logout: () => ipcRenderer.invoke('login:logout'),
  pickLocalTxt: () => ipcRenderer.invoke('local:pick'),
  openLocalTxt: (p) => ipcRenderer.invoke('local:open', p),
  localChapter: (bookId, index) => ipcRenderer.invoke('local:chapter', bookId, index),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  hideWindow: () => ipcRenderer.invoke('win:hide'),
  quitApp: () => ipcRenderer.invoke('win:close'),
  setPierce: (on) => ipcRenderer.invoke('win:pierce', on),
  resizeWindow: (w, h) => ipcRenderer.invoke('win:resize', w, h),
  onSettingsChanged: (fn) => ipcRenderer.on('settings-changed', (_e, s) => fn(s)),
  onOpenRequest: (fn) => ipcRenderer.on('open-request', (_e, text) => fn(text)),
  onOpenTxtRequest: (fn) => ipcRenderer.on('open-txt-request', (_e, p) => fn(p)),
});
