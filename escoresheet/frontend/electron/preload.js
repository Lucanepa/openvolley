// Preload script for Electron
// This runs in a context that has access to both the DOM and Node.js APIs
// but is isolated from the main renderer process for security

const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  onMenuAction: (callback) => {
    ipcRenderer.on('menu-action', (event, action) => callback(action))
  },
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  }
})
