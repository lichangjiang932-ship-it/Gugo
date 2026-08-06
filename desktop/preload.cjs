const { contextBridge, ipcRenderer } = require('electron')

const UPDATE_STATUS_CHANNEL = 'desktop:update-status'

contextBridge.exposeInMainWorld('gugoDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdateStatus(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener)
  },
}))
