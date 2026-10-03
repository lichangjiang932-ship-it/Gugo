import { createDesktopBrowserHost } from './browserHost.js'
import { createDesktopTerminalHost } from './terminalHost.js'

/**
 * The two hosts that own real OS resources for one window.
 *
 * They take the same three collaborators — the ipcMain they register on, the
 * origin the app is served from, and the window that owns them — and they have to
 * be released together when the app quits, or a docked browser view and a live
 * shell outlive the window they belonged to. Building and tearing them down in one
 * place keeps that pairing in a single spot instead of spreading it across the
 * entry file.
 */
export function createDesktopHosts({ ipcMain, getApplicationOrigin, getMainWindow }) {
  const browser = createDesktopBrowserHost({ ipcMain, getApplicationOrigin, getMainWindow })
  const terminal = createDesktopTerminalHost({ ipcMain, getApplicationOrigin, getMainWindow })

  return {
    register() {
      browser.register()
      terminal.register()
    },
    /** Idempotent: quitting twice must not throw. */
    dispose() {
      terminal.disposeAll()
      browser.destroy()
    },
  }
}
