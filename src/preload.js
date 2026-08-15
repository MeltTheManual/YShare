// YShare — preload bridge.
// Exposes a small, explicit, typed API from the main process to the renderer.
// The renderer NEVER touches the filesystem directly (ARCHITECTURE.md §2).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yshare', {
  // Version comes from the main process (app.getVersion() = package.json version).
  // NOTE: the preload is sandboxed — it cannot require() files like package.json.
  getVersion: () => ipcRenderer.invoke('app-version'),
  isPackaged: () => ipcRenderer.invoke('app-is-packaged'),

  // Sender side (source file on disk) — positioned reads for parallel ranges.
  pickFile: () => ipcRenderer.invoke('pick-file'),
  beginFileSend: (owner) => ipcRenderer.invoke('begin-file-send', owner),
  endFileSend: (owner) => ipcRenderer.invoke('end-file-send', owner),
  openRead: (owner) => ipcRenderer.invoke('open-read', owner),
  readChunk: (owner, offset, length) => ipcRenderer.invoke('read-chunk', owner, offset, length),
  closeRead: (owner) => ipcRenderer.invoke('close-read', owner),
  hashFile: (owner) => ipcRenderer.invoke('hash-file', owner),

  // Receiver side (write to the save folder) — positioned writes for parallel reassembly.
  beginReceive: (owner) => ipcRenderer.invoke('begin-receive', owner),
  openWrite: (owner, name, size) => ipcRenderer.invoke('open-write', owner, name, size),
  writeChunkAt: (owner, offset, chunk) => ipcRenderer.invoke('write-chunk-at', owner, offset, chunk),
  finishWrite: (owner, expectedHash) => ipcRenderer.invoke('finish-write', owner, expectedHash),
  completeWrite: (owner) => ipcRenderer.invoke('complete-write', owner),
  abortWrite: (owner) => ipcRenderer.invoke('abort-write', owner),

  // Folder transfer (CHUNK D). Sender: scan a folder + read its files by index.
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanFolder: () => ipcRenderer.invoke('scan-folder'),
  beginFolderSend: (owner) => ipcRenderer.invoke('begin-folder-send', owner),
  endFolderSend: (owner) => ipcRenderer.invoke('end-folder-send', owner),
  openReadFile: (owner, idx) => ipcRenderer.invoke('open-read-file', owner, idx),
  hashFileIdx: (owner, idx) => ipcRenderer.invoke('hash-file-idx', owner, idx),
  // Receiver: recreate the folder + write/verify each file.
  openWriteFolder: (owner, name) => ipcRenderer.invoke('open-write-folder', owner, name),
  openWriteFile: (owner, idx, relPath, size) => ipcRenderer.invoke('open-write-file', owner, idx, relPath, size),
  writeFileChunk: (owner, idx, offset, chunk) => ipcRenderer.invoke('write-file-chunk', owner, idx, offset, chunk),
  finishWriteFile: (owner, idx, expectedHash) => ipcRenderer.invoke('finish-write-file', owner, idx, expectedHash),
  abortFolder: (owner) => ipcRenderer.invoke('abort-folder', owner),
  completeFolder: (owner) => ipcRenderer.invoke('complete-folder', owner),

  // Close source handles and remove every partial receive before reload/exit.
  cleanupTransfers: () => ipcRenderer.invoke('cleanup-transfers'),

  // Settings — where received files are saved (persisted; default = OS Downloads).
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  pickDownloadDir: () => ipcRenderer.invoke('pick-download-dir'),
  resetDownloadDir: () => ipcRenderer.invoke('reset-download-dir'),

  // Settings — the Quick Connect signaling server (empty out of the box; YShare
  // runs no server of its own). Main validates before storing anything.
  getSignalEndpoint: () => ipcRenderer.invoke('get-signal-endpoint'),
  setSignalEndpoint: (value) => ipcRenderer.invoke('set-signal-endpoint', value),
  clearSignalEndpoint: () => ipcRenderer.invoke('clear-signal-endpoint'),

  // Serverless offer and reply links arrive through the operating system. Main
  // validates the URL before this narrow event reaches the unprivileged UI.
  onConnectionLink: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('connection-link', listener);
    return () => ipcRenderer.removeListener('connection-link', listener);
  },
});
