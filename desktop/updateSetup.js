import { createDesktopUpdateRuntime } from './updateRuntime.js'

export function configureDesktopUpdates({
  isPackaged,
  autoUpdater,
  updateBaseUrl,
  sendStatus,
  markReady,
}) {
  if (!isPackaged) return null

  // The built-in downloader discards a stalled differential transfer and then
  // starts the whole installer again. Keep electron-updater for release checks
  // and NSIS installation, while the desktop runtime owns resumable downloads.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Signed installations retain their certificate-derived publisher policy.
  // Explicitly unsigned installations rely on release HTTPS and SHA-512 for
  // integrity, without a Windows publisher identity guarantee.
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  let runtime
  try {
    runtime = createDesktopUpdateRuntime({
      updater: autoUpdater,
      updateBaseUrl,
      onStatus(payload = {}) {
        const { status, ...details } = payload
        if (status) sendStatus(status, details)
      },
    })
  } catch (error) {
    sendStatus('error', { message: error?.message || 'update runtime configuration failed' })
    return null
  }

  autoUpdater.on('checking-for-update', () => sendStatus('checking'))
  autoUpdater.on('update-available', (info) => sendStatus('available', { version: info.version }))
  autoUpdater.on('update-not-available', () => sendStatus('current'))
  autoUpdater.on('update-downloaded', (info) => {
    markReady()
    sendStatus('ready', { version: info.version })
  })
  autoUpdater.on('error', (error) => sendStatus('error', { message: error?.message || 'update failed' }))

  // Local-first default: configuring the updater must not contact a release
  // server. The only check entry point is the trusted IPC handler in main.js,
  // invoked after the user explicitly chooses "check and download".
  return runtime
}
