const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  onCommand: (cb) => ipcRenderer.on('cmd', (_e, msg) => cb(msg)),
  send: (msg) => ipcRenderer.send('sync-msg', msg),
});
