import path from 'node:path'
import fs from 'node:fs/promises'
import { realpath } from 'node:fs'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { desktopFileError, desktopFileOpenPolicy, normalizeDesktopFileReference } from '../shared/desktopFileReference.js'
import { desktopFileStatFingerprint, signDesktopFileMessage, verifyDesktopFileMessage } from '../server/utils/desktopFileProtocol.js'
import { isLoopbackHostname, isTrustedNavigation, parseHttpUrl } from './security.js'

// The signed service and saved grants use fs.realpathSync. On Windows the
// promises API uses native realpath and expands 8.3 names/casing differently.
// Keep the matching callback resolver asynchronous; do not relax path or stat
// equality to compensate for two different canonicalization algorithms.
const desktopFileSystem = { realpath: promisify(realpath), lstat: fs.lstat }

function trustedFileActionFrame(event, { mainWindow, applicationOrigin }) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  return contents && event.sender === contents && event.senderFrame === contents.mainFrame
    && isTrustedNavigation(event.senderFrame?.url, applicationOrigin)
}

function requestFileAction(payload, applicationOrigin) {
  const origin = parseHttpUrl(applicationOrigin)
  if (!origin || !isLoopbackHostname(origin.hostname) || origin.username || origin.password) {
    throw desktopFileError('DESKTOP_FILE_SERVICE_UNTRUSTED')
  }
  if (!['open', 'reveal'].includes(payload?.action)) throw desktopFileError('DESKTOP_FILE_ACTION_INVALID')
  const authToken = payload.authToken
  if (typeof authToken !== 'string' || !authToken || authToken.length > 8192 || /[\r\n\0]/u.test(authToken)) {
    throw desktopFileError('DESKTOP_FILE_AUTH_REQUIRED')
  }
  return { origin: origin.origin, action: payload.action, authToken, reference: normalizeDesktopFileReference(payload.reference) }
}

async function resolveFileActionTarget(request, { secret, fetchImpl, now }) {
  const nonce = randomBytes(16).toString('hex')
  const message = signDesktopFileMessage({
    nonce, issuedAt: now(), action: request.action, reference: request.reference,
  }, secret)
  const response = await fetchImpl(`${request.origin}/api/local-files/desktop-target`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.authToken}` },
    body: JSON.stringify(message),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(data?.error?.code || '') ? data.error.code : 'DESKTOP_FILE_RESOLVE_FAILED'
    throw desktopFileError(code)
  }
  const result = verifyDesktopFileMessage(await response.json(), secret, { nonce, now: now() })
  if (result.ok !== true || result.action !== request.action || result.issuedAt !== message.issuedAt) {
    throw desktopFileError('DESKTOP_FILE_SERVICE_UNTRUSTED')
  }
  return result.target
}

function isLocalRegularPath(fullPath) {
  if (typeof fullPath !== 'string' || !path.isAbsolute(fullPath)) return false
  if (Array.from(fullPath).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false
  if (/^(?:\\\\|\/\/)/u.test(fullPath)) return false
  if (process.platform !== 'win32') return true
  const segments = fullPath.replace(/^[a-z]:[\\/]/iu, '').split(/[\\/]/u)
  return segments.every((segment) => !segment.includes(':') && !/[ .]$/u.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))
}

async function verifyCurrentFile(target, fsImpl) {
  if (!isLocalRegularPath(target?.fullPath) || target.filename !== path.basename(target.fullPath)) {
    throw desktopFileError('DESKTOP_FILE_PATH_INVALID')
  }
  const canonical = await fsImpl.realpath(target.fullPath)
  const stat = await fsImpl.lstat(target.fullPath, { bigint: true })
  if (canonical !== target.fullPath || stat.isSymbolicLink() || !stat.isFile()
    || desktopFileStatFingerprint(stat) !== target.fingerprint) {
    throw desktopFileError('DESKTOP_FILE_CHANGED')
  }
}

export async function executeDesktopFileAction(payload, {
  applicationOrigin, secret, shellImpl, confirmOpen, fsImpl = desktopFileSystem, fetchImpl = fetch, now = Date.now,
  assertCanAct = () => {},
}) {
  const request = requestFileAction(payload, applicationOrigin)
  const options = { secret, fetchImpl, now }
  const target = await resolveFileActionTarget(request, options)
  await verifyCurrentFile(target, fsImpl)
  if (request.action === 'open') {
    const policy = desktopFileOpenPolicy(target.filename)
    if (!policy.allowed) throw desktopFileError('DESKTOP_FILE_OPEN_UNSAFE')
    if (policy.confirm) {
      if (!await confirmOpen?.(target)) return { ok: true, canceled: true, action: request.action }
      // The user can leave a confirmation open while grants or files change.
      // Re-resolve permissions, then require the very same confirmed file.
      const current = await resolveFileActionTarget(request, options)
      if (current.fullPath !== target.fullPath || current.fingerprint !== target.fingerprint) {
        throw desktopFileError('DESKTOP_FILE_CHANGED')
      }
    }
  }
  await verifyCurrentFile(target, fsImpl)
  assertCanAct()
  if (request.action === 'reveal') shellImpl.showItemInFolder(target.fullPath)
  else if (await shellImpl.openPath(target.fullPath)) throw desktopFileError('DESKTOP_FILE_OPEN_FAILED')
  return { ok: true, canceled: false, action: request.action }
}

export function registerDesktopFileIpc({ ipcMain, getContext, ...dependencies }) {
  const pending = new Set()
  ipcMain.handle('desktop:file-action', async (event, payload) => {
    const context = getContext()
    try {
      if (!trustedFileActionFrame(event, context)) throw desktopFileError('DESKTOP_FILE_SENDER_UNTRUSTED')
      if (pending.has(event.sender)) throw desktopFileError('DESKTOP_FILE_ACTION_PENDING')
      pending.add(event.sender)
      try {
        return await executeDesktopFileAction(payload, {
          ...dependencies, ...context,
          assertCanAct: () => {
            if (!trustedFileActionFrame(event, getContext())) throw desktopFileError('DESKTOP_FILE_SENDER_UNTRUSTED')
          },
        })
      } finally {
        pending.delete(event.sender)
      }
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code || '') ? error.code : 'DESKTOP_FILE_ACTION_FAILED'
      return { ok: false, error: { code } }
    }
  })
}
