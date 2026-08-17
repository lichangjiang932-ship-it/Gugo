const { contextBridge, ipcRenderer } = require('electron')

const UPDATE_STATUS_CHANNEL = 'desktop:update-status'
const PET_STATE_CHANNEL = 'desktop:pet-state'
const PET_VISIBILITY_CHANNEL = 'desktop:pet-visibility'
const PET_DRAG_CANCEL_CHANNEL = 'desktop:pet-drag-cancel'

contextBridge.exposeInMainWorld('gugoDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  writeClipboardText: (value) => ipcRenderer.invoke('desktop:write-clipboard-text', String(value ?? '')),
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  openConfigFile: () => ipcRenderer.invoke('desktop:open-config-file'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  setPetVisible: (visible) => ipcRenderer.invoke('desktop:set-pet-visible', visible === true),
  resizePetWindow: ({ customImage = false, scale = 1 } = {}) => ipcRenderer.invoke('desktop:resize-pet-window', {
    customImage: customImage === true,
    scale: Number(scale),
  }),
  dragPetWindow: ({ phase = '' } = {}) => ipcRenderer.send('desktop:pet-drag', {
    phase: String(phase),
  }),
  updatePetStatus: (status) => ipcRenderer.invoke('desktop:update-pet-status', status),
  getPetState: () => ipcRenderer.invoke('desktop:get-pet-state'),
  hidePet: () => ipcRenderer.invoke('desktop:hide-pet'),
  showPetMenu: () => ipcRenderer.invoke('desktop:show-pet-menu'),
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
  onPetDragCancel(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on(PET_DRAG_CANCEL_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PET_DRAG_CANCEL_CHANNEL, listener)
  },
  onUpdateStatus(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener)
  },
}))
