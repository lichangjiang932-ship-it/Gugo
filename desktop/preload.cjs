const { contextBridge, ipcRenderer } = require('electron')

const UPDATE_STATUS_CHANNEL = 'desktop:update-status'
const PET_STATE_CHANNEL = 'desktop:pet-state'
const PET_VISIBILITY_CHANNEL = 'desktop:pet-visibility'

contextBridge.exposeInMainWorld('gugoDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  setPetVisible: (visible) => ipcRenderer.invoke('desktop:set-pet-visible', visible === true),
  updatePetStatus: (status) => ipcRenderer.invoke('desktop:update-pet-status', status),
  getPetState: () => ipcRenderer.invoke('desktop:get-pet-state'),
  hidePet: () => ipcRenderer.invoke('desktop:hide-pet'),
  onPetState(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => callback(state)
    ipcRenderer.on(PET_STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PET_STATE_CHANNEL, listener)
  },
  onPetVisibility(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, visible) => callback(visible)
    ipcRenderer.on(PET_VISIBILITY_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PET_VISIBILITY_CHANNEL, listener)
  },
  onUpdateStatus(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener)
  },
}))
