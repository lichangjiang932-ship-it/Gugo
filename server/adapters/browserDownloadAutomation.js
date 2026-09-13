import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import { ACTION_TIMEOUT_MS, abortableDelay, throwIfAborted } from './browserCdpClient.js'
import { elementExpression } from './browserDomAutomation.js'
import { activeBrowserFrameEvaluationParams } from './browserFrameAutomation.js'

export const DEFAULT_BROWSER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024
export const HARD_BROWSER_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024
export const DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS = 120_000
export const MAX_BROWSER_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000

function browserDownloadError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false })
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function downloadDirectoryEntries(directory) {
  const partial = []
  const complete = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw browserDownloadError('Browser download created an unsafe symbolic link.', 'BROWSER_DOWNLOAD_UNSAFE_FILE')
    }
    if (!entry.isFile()) continue
    if (/\.(?:crdownload|part|tmp)$/iu.test(entry.name)) partial.push(fullPath)
    else complete.push(fullPath)
  }
  return { partial, complete }
}

export async function waitForBrowserDownload({
  directory,
  timeoutMs = DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  maxBytes = DEFAULT_BROWSER_DOWNLOAD_MAX_BYTES,
  signal = null,
} = {}) {
  const deadline = Date.now() + clampInteger(
    timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS, 1_000, MAX_BROWSER_DOWNLOAD_TIMEOUT_MS,
  )
  const sizeLimit = clampInteger(
    maxBytes, DEFAULT_BROWSER_DOWNLOAD_MAX_BYTES, 1, HARD_BROWSER_DOWNLOAD_MAX_BYTES,
  )
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const entries = downloadDirectoryEntries(directory)
    for (const filePath of [...entries.partial, ...entries.complete]) {
      if (fs.statSync(filePath).size > sizeLimit) {
        throw browserDownloadError(
          `Browser download exceeds the ${sizeLimit} byte safety limit.`,
          'BROWSER_DOWNLOAD_TOO_LARGE',
          413,
        )
      }
    }
    if (entries.complete.length > 1) {
      throw browserDownloadError(
        'Browser action produced multiple files; no destination was published.',
        'BROWSER_DOWNLOAD_MULTIPLE_FILES',
      )
    }
    if (entries.complete.length === 1 && entries.partial.length === 0) {
      const sourcePath = fs.realpathSync(entries.complete[0])
      const stat = fs.statSync(sourcePath)
      if (!stat.isFile()) {
        throw browserDownloadError('Browser download is not a regular file.', 'BROWSER_DOWNLOAD_UNSAFE_FILE')
      }
      return { sourcePath, filename: path.basename(sourcePath), bytes: stat.size }
    }
    await abortableDelay(100, signal)
  }
  throw browserDownloadError('Browser download did not complete before the timeout.', 'BROWSER_DOWNLOAD_TIMEOUT', 408)
}

export async function downloadFromBrowserElement(session, {
  target,
  stagingDirectory,
  timeoutMs,
  maxBytes,
  signal = null,
} = {}) {
  throwIfAborted(signal)
  fs.mkdirSync(stagingDirectory, { recursive: true })
  await session.client.request('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: stagingDirectory,
  }, session.sessionId, ACTION_TIMEOUT_MS, signal)
  try {
    const evaluated = await session.client.request('Runtime.evaluate', {
      expression: elementExpression(target, `el.scrollIntoView({block:'center'}); el.click(); return {ok:true}`),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...activeBrowserFrameEvaluationParams(session),
    }, session.sessionId, ACTION_TIMEOUT_MS, signal)
    if (evaluated.exceptionDetails) {
      throw browserDownloadError('Browser download click failed.', 'BROWSER_DOWNLOAD_CLICK_FAILED')
    }
    const clicked = evaluated.result?.value
    if (!clicked?.ok) {
      throw browserDownloadError(clicked?.error || 'Browser download target was not found.', 'BROWSER_DOWNLOAD_TARGET_NOT_FOUND', 404)
    }
    return waitForBrowserDownload({ directory: stagingDirectory, timeoutMs, maxBytes, signal })
  } finally {
    try {
      await session.client.request('Page.setDownloadBehavior', { behavior: 'deny' }, session.sessionId, ACTION_TIMEOUT_MS, signal)
    } catch { /* browser shutdown or cancellation already prevents another download */ }
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function publishBrowserDownload({
  sourcePath,
  destination,
  overwrite = false,
} = {}) {
  const directory = path.dirname(destination)
  fs.mkdirSync(directory, { recursive: true })
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`
  const temporary = path.join(directory, `.gugo-browser-download-${suffix}.part`)
  const backup = path.join(directory, `.gugo-browser-download-${suffix}.backup`)
  let backedUp = false
  try {
    const existing = await fs.promises.lstat(destination).catch((error) => (
      error?.code === 'ENOENT' ? null : Promise.reject(error)
    ))
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw browserDownloadError(
        'Download destination must be a regular file or a missing path.',
        'BROWSER_DOWNLOAD_UNSAFE_DESTINATION',
      )
    }
    await fs.promises.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL)
    const handle = await fs.promises.open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    if (!overwrite) {
      try { await fs.promises.link(temporary, destination) } catch (error) {
        if (error?.code === 'EEXIST') {
          throw browserDownloadError(
            'Download destination exists; set overwrite=true only after confirming replacement.',
            'BROWSER_DOWNLOAD_TARGET_EXISTS',
            409,
          )
        }
        throw error
      }
      await fs.promises.rm(temporary, { force: true })
    } else {
      if (fs.existsSync(destination)) {
        await fs.promises.rename(destination, backup)
        backedUp = true
      }
      try {
        await fs.promises.rename(temporary, destination)
      } catch (error) {
        if (backedUp) await fs.promises.rename(backup, destination)
        backedUp = false
        throw error
      }
      if (backedUp) await fs.promises.rm(backup, { force: true })
      backedUp = false
    }
    const stat = await fs.promises.stat(destination)
    return { bytes: stat.size, sha256: await sha256File(destination) }
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
    if (backedUp && !fs.existsSync(destination)) {
      await fs.promises.rename(backup, destination).catch(() => {})
    }
    await fs.promises.rm(backup, { force: true }).catch(() => {})
  }
}
