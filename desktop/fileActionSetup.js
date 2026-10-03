import { randomBytes } from 'node:crypto'
import { normalizeProductLanguage } from '../shared/productLanguage.js'
import { isDesktopBridgeSecret } from '../server/utils/desktopFileProtocol.js'
import { registerDesktopFileIpc } from './fileActions.js'

function fileOpenConfirmation({ app, dialog, getContext }) {
  return async ({ filename }) => {
    const chinese = normalizeProductLanguage(app.getLocale(), 'en') === 'zh'
    const result = await dialog.showMessageBox(getContext().mainWindow, {
      type: 'warning', defaultId: 0, cancelId: 0,
      buttons: chinese ? ['取消', '打开'] : ['Cancel', 'Open'],
      title: chinese ? '在默认应用中打开文件' : 'Open in the default application',
      message: filename,
      detail: chinese
        ? '此文件可能包含可执行的网页内容。外部应用不受 Gugo 预览沙箱保护，仅在信任文件来源时打开。'
        : 'This file may contain active web content. External applications are outside the Gugo preview sandbox. Open only if you trust its source.',
    })
    return result.response === 1
  }
}

/** Keep native-file lifecycle and its explicit user confirmation out of the
 * general desktop lifecycle/updater. No key is written to disk or exposed in
 * the renderer bridge; main passes it only to its own backend process. */
export function createDesktopFileActionSetup({ app, dialog, ipcMain, shell, env = process.env }) {
  const secret = isDesktopBridgeSecret(env.GUGO_DESKTOP_BRIDGE_SECRET)
    ? env.GUGO_DESKTOP_BRIDGE_SECRET : randomBytes(32).toString('hex')
  return Object.freeze({
    secret,
    register(getContext) {
      registerDesktopFileIpc({
        ipcMain, shellImpl: shell,
        getContext: () => ({ ...getContext(), secret }),
        confirmOpen: fileOpenConfirmation({ app, dialog, getContext }),
      })
    },
  })
}
