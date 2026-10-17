import { clipboard } from 'electron'

/** Clipboard access for the trusted app frame, including the embedded terminal. */
export function registerClipboardIpc({ ipcMain, assertTrusted, getMainWindow }) {
  ipcMain.handle('desktop:write-clipboard-text', (event, value) => {
    assertTrusted(event)
    clipboard.writeText(String(value ?? ''))
    return { copied: true }
  })
  ipcMain.handle('desktop:read-clipboard-text', (event) => {
    assertTrusted(event)
    // Reading is narrower than writing: only the main app window, not the pet
    // window that shares the same preload and origin.
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.() || event.sender !== window.webContents) {
      throw new Error('clipboard reads are only available to the main window')
    }
    return { text: clipboard.readText() }
  })
}
