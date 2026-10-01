const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = ['events', 'external', 'settings', 'feed-status', 'select-date', 'open-add', 'assistant-files', 'ai-progress', 'sync-state'];

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  addEvent: (e) => ipcRenderer.invoke('add-event', e),
  updateEvent: (id, e) => ipcRenderer.invoke('update-event', id, e),
  deleteEvent: (id) => ipcRenderer.invoke('delete-event', id),
  getFonts: () => ipcRenderer.invoke('get-fonts'),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  resetSettings: (keys) => ipcRenderer.invoke('reset-settings', keys),
  openSettings: (section) => ipcRenderer.invoke('open-settings', section),
  syncStatus: () => ipcRenderer.invoke('sync-status'),
  syncLogin: (email, password) => ipcRenderer.invoke('sync-login', email, password),
  syncLogout: () => ipcRenderer.invoke('sync-logout'),
  refreshFeeds: () => ipcRenderer.invoke('refresh-feeds'),
  windowAction: (name) => ipcRenderer.invoke('window-action', name),
  // AI 비서
  openAssistant: (paths) => ipcRenderer.invoke('open-assistant', paths),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pathsForFiles: (files) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  analyze: (req) => ipcRenderer.invoke('ai-analyze', req),
  addItems: (items) => ipcRenderer.invoke('ai-add', items),
  undoItems: (ids) => ipcRenderer.invoke('ai-undo', ids),
  aiCommand: (req) => ipcRenderer.invoke('ai-command', req),
  restoreItems: (list) => ipcRenderer.invoke('ai-restore', list),
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  setKey: (provider, key) => ipcRenderer.invoke('ai-set-key', provider, key),
  testKey: (provider) => ipcRenderer.invoke('ai-test', provider),
  claudeCodeInfo: () => ipcRenderer.invoke('claude-code-info'),
  copyText: (t) => ipcRenderer.invoke('copy-text', t),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  resizeStart: (edge) => ipcRenderer.send('resize-start', edge),
  resizeMove: (dx, dy) => ipcRenderer.send('resize-move', dx, dy),
  resizeEnd: () => ipcRenderer.send('resize-end'),
  on: (ch, cb) => {
    if (CHANNELS.includes(ch)) ipcRenderer.on(ch, (_e, data) => cb(data));
  },
});
