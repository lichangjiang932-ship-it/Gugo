const { contextBridge, ipcRenderer } = require('electron')

const UPDATE_STATUS_CHANNEL = 'desktop:update-status'
const PET_STATE_CHANNEL = 'desktop:pet-state'
const PET_VISIBILITY_CHANNEL = 'desktop:pet-visibility'
const PET_DRAG_CANCEL_CHANNEL = 'desktop:pet-drag-cancel'
const BROWSER_UPDATED_CHANNEL = 'desktop:browser-updated'
const TERMINAL_DATA_CHANNEL = 'desktop:terminal-data'
const TERMINAL_EXIT_CHANNEL = 'desktop:terminal-exit'

contextBridge.exposeInMainWorld('gugoDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  writeClipboardText: (value) => ipcRenderer.invoke('desktop:write-clipboard-text', String(value ?? '')),
  openDirectory: ({ defaultPath = '' } = {}) => ipcRenderer.invoke('desktop:select-directory', {
    defaultPath: String(defaultPath ?? ''),
  }),
  selectDirectory: ({ defaultPath = '' } = {}) => ipcRenderer.invoke('desktop:select-directory', {
    defaultPath: String(defaultPath ?? ''),
  }),
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  openConfigFile: () => ipcRenderer.invoke('desktop:open-config-file'),
  fileAction: ({ action, reference, authToken } = {}) => ipcRenderer.invoke('desktop:file-action', {
    action, reference, authToken,
  }),
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
  // A real shell in the desktop app. The main process owns the pty; the panel only
  // sends keystrokes and receives output.
  terminal: Object.freeze({
    start: (options) => ipcRenderer.invoke('desktop:terminal-start', options || {}),
    write: (id, data) => ipcRenderer.invoke('desktop:terminal-write', { id, data: String(data ?? '') }),
    resize: (id, cols, rows) => ipcRenderer.invoke('desktop:terminal-resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('desktop:terminal-kill', { id }),
    onData(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(TERMINAL_DATA_CHANNEL, listener)
      return () => ipcRenderer.removeListener(TERMINAL_DATA_CHANNEL, listener)
    },
    onExit(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(TERMINAL_EXIT_CHANNEL, listener)
      return () => ipcRenderer.removeListener(TERMINAL_EXIT_CHANNEL, listener)
    },
  }),
  // Docked browser: the renderer reports where its panel is and asks for a URL;
  // the main process owns the view and decides whether either request is allowed.
  browser: Object.freeze({
    navigate: (url) => ipcRenderer.invoke('desktop:browser-navigate', String(url ?? '')),
    action: (name) => ipcRenderer.invoke('desktop:browser-action', String(name ?? '')),
    back: () => ipcRenderer.invoke('desktop:browser-action', 'back'),
    forward: () => ipcRenderer.invoke('desktop:browser-action', 'forward'),
    reload: () => ipcRenderer.invoke('desktop:browser-action', 'reload'),
    stop: () => ipcRenderer.invoke('desktop:browser-action', 'stop'),
    setBounds: (rect) => ipcRenderer.invoke('desktop:browser-set-bounds', rect || null),
    state: () => ipcRenderer.invoke('desktop:browser-state'),
    // Page facts, for the preview panel and the agent verifying through it.
    capture: () => ipcRenderer.invoke('desktop:preview-capture'),
    evaluate: (script) => ipcRenderer.invoke('desktop:preview-evaluate', String(script ?? '')),
    consoleEntries: (options) => ipcRenderer.invoke('desktop:preview-console', options || {}),
    hide: () => ipcRenderer.invoke('desktop:browser-hide'),
    destroy: () => ipcRenderer.invoke('desktop:browser-destroy'),
    onUpdated(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, state) => callback(state)
      ipcRenderer.on(BROWSER_UPDATED_CHANNEL, listener)
      return () => ipcRenderer.removeListener(BROWSER_UPDATED_CHANNEL, listener)
    },
  }),
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
