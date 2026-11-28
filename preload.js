'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// R86：预热 IPC 通道——启动期第一次 invoke 的往返实测约 40ms（通道冷启动 + 主进程正忙于建窗），
// 预热这条空消息不会改变任何状态，只是把这段开销挪到 HTML 解析期间并行发生。
try {
  ipcRenderer.invoke('app:ping').catch(() => {});
} catch {
  /* ignore */
}

contextBridge.exposeInMainWorld('shell', {
  info: () => ipcRenderer.invoke('app:info'),
  // R141：首屏数据与监听器就绪后通知主进程补发加载前事件
  rendererReady: () => ipcRenderer.invoke('app:renderer-ready'),
  security: () => ipcRenderer.invoke('app:security'),
  meta: () => ipcRenderer.invoke('app:meta'),
  paths: () => ipcRenderer.invoke('app:paths'),
  iconInfo: () => ipcRenderer.invoke('app:iconInfo'),
  gpu: () => ipcRenderer.invoke('app:gpu'),
  perf: (label, value) => ipcRenderer.invoke('perf:log', label, value),
  onGpuCrashed: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('gpu:crashed', fn);
    return () => ipcRenderer.removeListener('gpu:crashed', fn);
  },
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  listDir: (root, rel, offset, limit) => ipcRenderer.invoke('fs:list', { root, rel, offset, limit }),
  readFile: (root, rel) => ipcRenderer.invoke('fs:read', { root, rel }),
  writeFile: (root, rel, content, expected) => ipcRenderer.invoke('fs:write', { root, rel, content, expected }),
  modelContext: (modelId) => ipcRenderer.invoke('model:context', modelId),
  saveAttachment: (payload) => ipcRenderer.invoke('attachment:save', payload),
  pickImages: () => ipcRenderer.invoke('attachment:pick'),
  gitStatus: (cwd, force) => ipcRenderer.invoke('git:status', { cwd, force }),
  gitDiff: (cwd, rel, includeStaged) => ipcRenderer.invoke('git:diff', { cwd, rel, includeStaged }),
  gitStage: (cwd, rel, stage) => ipcRenderer.invoke('git:stage', { cwd, rel, stage }),
  gitCommit: (cwd, message) => ipcRenderer.invoke('git:commit', { cwd, message }),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  cliVersion: () => ipcRenderer.invoke('cli:version'),
  cliProbe: () => ipcRenderer.invoke('cli:probe'),
  kernelSelfHeal: () => ipcRenderer.invoke('kernel:selfheal'),
  kernelStatus: () => ipcRenderer.invoke('kernel:status'),
  kernelInstall: () => ipcRenderer.invoke('kernel:install'),
  applyTheme: (theme) => ipcRenderer.invoke('theme:apply', theme),
  reportError: (info) => ipcRenderer.invoke('renderer:error', info),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  loginItem: (enable) => ipcRenderer.invoke('app:loginItem', enable),
  notify: (payload) => ipcRenderer.invoke('app:notify', payload),
  setExtension: (name, enabled) => ipcRenderer.invoke('extensions:set', { name, enabled }),
  searchFiles: (root, query) => ipcRenderer.invoke('fs:search', { root, query }),
  hooksGet: () => ipcRenderer.invoke('hooks:get'),
  hooksSave: (content) => ipcRenderer.invoke('hooks:save', content),
  exportSession: (payload) => ipcRenderer.invoke('session:export', payload),
  // R121：导出为 PDF（payload: { title, html }）
  exportSessionPdf: (payload) => ipcRenderer.invoke('session:exportPdf', payload),
  saveTextFile: (opts) => ipcRenderer.invoke('file:save-text', opts),
  openTextFile: (opts) => ipcRenderer.invoke('file:open-text', opts),
  restoreBackup: (target) => ipcRenderer.invoke('file:restore-bak', target),
  logInfo: () => ipcRenderer.invoke('log:info'),
  usage: (range) => ipcRenderer.invoke('usage:get', range),
  storageStats: () => ipcRenderer.invoke('storage:stats'),

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (cfg) => ipcRenderer.invoke('config:save', cfg),
    validate: (cfg) => ipcRenderer.invoke('config:validate', cfg),
    redactionSelfTest: () => ipcRenderer.invoke('config:redactionSelfTest'),
    test: (o) => ipcRenderer.invoke('config:test', o),
    testModel: (o) => ipcRenderer.invoke('config:test-model', o),
    exportFile: (opts) => ipcRenderer.invoke('config:export', opts),
    exportPreview: (opts) => ipcRenderer.invoke('config:exportPreview', opts),
    importFile: () => ipcRenderer.invoke('config:import'),
  },

  extras: () => ipcRenderer.invoke('extras:get'),
  saveMcp: (servers) => ipcRenderer.invoke('mcp:save', servers),
  saveMemory: (content) => ipcRenderer.invoke('memory:save', content),
  projectContextGet: (cwd) => ipcRenderer.invoke('project:context:get', { cwd }),
  projectContextSave: (cwd, content) => ipcRenderer.invoke('project:context:save', { cwd, content }),
  projectContextRestore: (cwd) => ipcRenderer.invoke('project:context:restore', { cwd }),
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    save: (patch) => ipcRenderer.invoke('prefs:save', patch),
  },

  win: {
    isFocused: () => ipcRenderer.invoke('win:isFocused'),
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (id) => ipcRenderer.invoke('sessions:get', id),
    // R90：批量取正文（后台补水用，一次最多 50 个）
    getBatch: (ids) => ipcRenderer.invoke('sessions:get-batch', ids),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    flush: () => ipcRenderer.invoke('sessions:flush'),
    remove: (id) => ipcRenderer.invoke('sessions:delete', id),
    clear: () => ipcRenderer.invoke('sessions:clear'),
    trashList: (offset = 0, limit = 20) => ipcRenderer.invoke('sessions:trash:list', { offset, limit }),
    trashRestore: (file) => ipcRenderer.invoke('sessions:trash:restore', { file }),
    backupInfo: () => ipcRenderer.invoke('sessions:backupInfo'),
    backupRead: () => ipcRenderer.invoke('sessions:backup:read'),
    backupRestore: (sessions) => ipcRenderer.invoke('sessions:backup:restore', { sessions }),
    backupNow: () => ipcRenderer.invoke('sessions:backupNow'),
    sizes: () => ipcRenderer.invoke('sessions:sizes'),
    slim: (id) => ipcRenderer.invoke('sessions:slim', id),
  },

  checkpoint: {
    create: (sessionId, cwd) => ipcRenderer.invoke('checkpoint:create', { sessionId, cwd }),
    list: (sessionId) => ipcRenderer.invoke('checkpoint:list', { sessionId }),
    diff: (sessionId, id, cwd) => ipcRenderer.invoke('checkpoint:diff', { sessionId, id, cwd }),
    readVersion: (sessionId, id, rel) =>
      ipcRenderer.invoke('checkpoint:readVersion', { sessionId, id, rel }),
    restore: (sessionId, id, cwd, deleteAdded) =>
      ipcRenderer.invoke('checkpoint:restore', { sessionId, id, cwd, deleteAdded }),
    deleteAll: (sessionId) => ipcRenderer.invoke('checkpoint:deleteAll', { sessionId }),
  },

  chat: {
    send: (session, text) => ipcRenderer.invoke('chat:send', { session, text }),
    interrupt: (sessionId) => ipcRenderer.invoke('chat:interrupt', { sessionId }),
    setEffort: (sessionId, tier) => ipcRenderer.invoke('chat:set-effort', { sessionId, tier }),
    approval: (sessionId, requestId, allowed) =>
      ipcRenderer.invoke('chat:approval', { sessionId, requestId, allowed }),
  },

  restart: (session) => ipcRenderer.invoke('agent:restart', { session: { id: session.id } }),

  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  confirm: (payload) => ipcRenderer.invoke('dialog:confirm', payload),

  onAgentEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },

  // R88：会话落盘失败/恢复（磁盘满、目录只读、文件被占用）——界面必须能提示到位
  onSaveError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sessions:save-error', handler);
    return () => ipcRenderer.removeListener('sessions:save-error', handler);
  },
  onSaveOk: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sessions:save-ok', handler);
    return () => ipcRenderer.removeListener('sessions:save-ok', handler);
  },

  onApproval: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:approval', handler);
    return () => ipcRenderer.removeListener('agent:approval', handler);
  },
  onApprovalClear: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:approval-clear', handler);
    return () => ipcRenderer.removeListener('agent:approval-clear', handler);
  },

  onMenuAction: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },

  onSmokeStart: (cb) => {
    ipcRenderer.on('smoke:start', () => cb());
  },

  onSmokeSettings: (cb) => {
    ipcRenderer.on('smoke:settings', () => cb());
  },

  onSmokeStopTest: (cb) => {
    ipcRenderer.on('smoke:stop-test', () => cb());
  },

  turnDone: (sessionId) => ipcRenderer.send('chat:turn-done', sessionId),
});
