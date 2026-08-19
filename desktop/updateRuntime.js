import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

export const DEFAULT_UPDATE_CHUNK_SIZE = 2 * 1024 * 1024
export const MIN_UPDATE_CHUNK_SIZE = 1 * 1024 * 1024
export const MAX_UPDATE_CHUNK_SIZE = 4 * 1024 * 1024
export const DEFAULT_UPDATE_RANGE_ATTEMPTS = 3
export const DEFAULT_UPDATE_RANGE_IDLE_MS = 60_000

function updateError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(filePath, algorithm = 'sha512', encoding = 'base64') {
  const hash = createHash(algorithm)
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest(encoding)
}

function boundedChunkSize(value) {
  const size = Number(value) || DEFAULT_UPDATE_CHUNK_SIZE
  return Math.max(MIN_UPDATE_CHUNK_SIZE, Math.min(MAX_UPDATE_CHUNK_SIZE, Math.floor(size)))
}

function blockMapFile(blockMap, label) {
  const file = blockMap?.files?.[0]
  if (!file || !Array.isArray(file.sizes) || !Array.isArray(file.checksums)) {
    throw updateError(`${label} blockmap is invalid`, 'UPDATE_BLOCKMAP_INVALID')
  }
  if (file.sizes.length !== file.checksums.length || file.sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
    throw updateError(`${label} blockmap blocks are invalid`, 'UPDATE_BLOCKMAP_INVALID')
  }
  return file
}

export function blockMapSize(blockMap) {
  return blockMapFile(blockMap, 'update').sizes.reduce((total, size) => total + size, 0)
}

export function parseBlockMap(buffer) {
  try {
    return JSON.parse(gunzipSync(buffer).toString('utf8'))
  } catch (cause) {
    throw updateError('update blockmap cannot be parsed', 'UPDATE_BLOCKMAP_INVALID', cause)
  }
}

function appendOperation(operations, operation) {
  const previous = operations.at(-1)
  if (previous
    && previous.kind === operation.kind
    && previous.sourceEnd === operation.sourceStart
    && previous.outputEnd === operation.outputStart) {
    previous.sourceEnd = operation.sourceEnd
    previous.outputEnd = operation.outputEnd
    return
  }
  operations.push(operation)
}

export function computeDifferentialOperations(oldBlockMap, newBlockMap) {
  if (oldBlockMap?.version !== newBlockMap?.version) {
    throw updateError('blockmap versions do not match', 'UPDATE_BLOCKMAP_VERSION_MISMATCH')
  }
  const oldFile = blockMapFile(oldBlockMap, 'current')
  const newFile = blockMapFile(newBlockMap, 'next')
  if (oldFile.name !== newFile.name) {
    throw updateError('blockmap file names do not match', 'UPDATE_BLOCKMAP_FILE_MISMATCH')
  }

  const oldBlocks = new Map()
  let oldOffset = Number(oldFile.offset) || 0
  for (let index = 0; index < oldFile.checksums.length; index += 1) {
    const checksum = oldFile.checksums[index]
    const size = oldFile.sizes[index]
    if (!oldBlocks.has(checksum)) oldBlocks.set(checksum, { offset: oldOffset, size })
    oldOffset += size
  }

  const operations = []
  let newOffset = Number(newFile.offset) || 0
  for (let index = 0; index < newFile.checksums.length; index += 1) {
    const size = newFile.sizes[index]
    const oldBlock = oldBlocks.get(newFile.checksums[index])
    const canCopy = oldBlock?.size === size
    appendOperation(operations, {
      kind: canCopy ? 'copy' : 'download',
      sourceStart: canCopy ? oldBlock.offset : newOffset,
      sourceEnd: (canCopy ? oldBlock.offset : newOffset) + size,
      outputStart: newOffset,
      outputEnd: newOffset + size,
    })
    newOffset += size
  }
  return operations
}

function splitDownloadOperations(operations, chunkSize) {
  const bounded = boundedChunkSize(chunkSize)
  const result = []
  for (const operation of operations) {
    if (operation.kind !== 'download') {
      result.push(operation)
      continue
    }
    let sourceStart = operation.sourceStart
    let outputStart = operation.outputStart
    while (sourceStart < operation.sourceEnd) {
      const length = Math.min(bounded, operation.sourceEnd - sourceStart)
      result.push({
        kind: 'download',
        sourceStart,
        sourceEnd: sourceStart + length,
        outputStart,
        outputEnd: outputStart + length,
      })
      sourceStart += length
      outputStart += length
    }
  }
  return result
}

export function buildUpdatePlan({ size, oldBlockMap = null, newBlockMap = null, chunkSize } = {}) {
  const totalSize = Number(size)
  if (!Number.isInteger(totalSize) || totalSize <= 0) {
    throw updateError('update size is invalid', 'UPDATE_SIZE_INVALID')
  }
  let mode = 'full'
  let operations = [{ kind: 'download', sourceStart: 0, sourceEnd: totalSize, outputStart: 0, outputEnd: totalSize }]
  if (oldBlockMap && newBlockMap && blockMapSize(newBlockMap) === totalSize) {
    operations = computeDifferentialOperations(oldBlockMap, newBlockMap)
    mode = 'differential'
  }
  operations = splitDownloadOperations(operations, chunkSize)
  const downloadBytes = operations
    .filter((operation) => operation.kind === 'download')
    .reduce((total, operation) => total + operation.outputEnd - operation.outputStart, 0)
  return { mode, size: totalSize, downloadBytes, operations }
}

function rangeKey(operation) {
  return `${operation.sourceStart}-${operation.sourceEnd}:${operation.outputStart}-${operation.outputEnd}`
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(filePath, JSON.stringify(value), 'utf8')
}

async function readAt(handle, start, length) {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset)
    if (bytesRead === 0) throw updateError('update partial file ended early', 'UPDATE_PARTIAL_TRUNCATED')
    offset += bytesRead
  }
  return buffer
}

async function writeAt(handle, start, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, start + offset)
    if (bytesWritten === 0) throw updateError('update partial file write stalled', 'UPDATE_PARTIAL_WRITE_STALLED')
    offset += bytesWritten
  }
}

async function copyOperation(sourceHandle, targetHandle, operation, copyChunkSize) {
  let sourceOffset = operation.sourceStart
  let outputOffset = operation.outputStart
  while (sourceOffset < operation.sourceEnd) {
    const length = Math.min(copyChunkSize, operation.sourceEnd - sourceOffset)
    const buffer = await readAt(sourceHandle, sourceOffset, length)
    await writeAt(targetHandle, outputOffset, buffer)
    sourceOffset += length
    outputOffset += length
  }
}

function linkAbortSignal(source, controller) {
  if (!source) return () => {}
  if (source.aborted) {
    controller.abort(source.reason)
    return () => {}
  }
  const abort = () => controller.abort(source.reason)
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

export async function fetchRangeBuffer({
  url,
  start,
  end,
  fetchImpl = globalThis.fetch,
  headers = {},
  idleTimeoutMs = DEFAULT_UPDATE_RANGE_IDLE_MS,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw updateError('fetch is unavailable', 'UPDATE_FETCH_UNAVAILABLE')
  const expected = end - start
  const controller = new AbortController()
  const unlink = linkAbortSignal(signal, controller)
  let timer = null
  const armIdle = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(updateError('update range timed out', 'UPDATE_RANGE_TIMEOUT')), idleTimeoutMs)
  }
  try {
    armIdle()
    const response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { ...headers, accept: '*/*', 'accept-encoding': 'identity', range: `bytes=${start}-${end - 1}` },
      signal: controller.signal,
    })
    if (response.status !== 206) {
      throw updateError(`update server did not honor Range (HTTP ${response.status})`, 'UPDATE_RANGE_UNSUPPORTED')
    }
    const contentRange = response.headers.get('content-range')
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(contentRange || ''))
    if (!match || Number(match[1]) !== start || Number(match[2]) !== end - 1) {
      throw updateError('update server returned a mismatched Content-Range', 'UPDATE_RANGE_MISMATCH')
    }
    const reader = response.body?.getReader?.()
    if (!reader) throw updateError('update response body is unavailable', 'UPDATE_BODY_UNAVAILABLE')
    const chunks = []
    let received = 0
    while (true) {
      armIdle()
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      received += chunk.length
      if (received > expected) throw updateError('update range exceeded its declared size', 'UPDATE_RANGE_OVERFLOW')
    }
    if (received !== expected) {
      throw updateError(`update range was truncated (${received}/${expected})`, 'UPDATE_RANGE_TRUNCATED')
    }
    return Buffer.concat(chunks, received)
  } catch (cause) {
    if (cause?.code?.startsWith?.('UPDATE_')) throw cause
    if (controller.signal.aborted && controller.signal.reason?.code) throw controller.signal.reason
    throw updateError('update range request failed', 'UPDATE_RANGE_FAILED', cause)
  } finally {
    if (timer) clearTimeout(timer)
    unlink()
  }
}

async function fetchBufferWithRetry({ url, fetchImpl, headers, maxAttempts, sleep, retryBaseMs }) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow', headers: { ...headers, accept: '*/*' } })
      if (!response.ok) throw updateError(`update metadata returned HTTP ${response.status}`, 'UPDATE_METADATA_HTTP')
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) await sleep(retryBaseMs * (2 ** (attempt - 1)))
    }
  }
  throw updateError('update metadata download failed', 'UPDATE_METADATA_FAILED', lastError)
}

function planFingerprint({ url, sha512, plan, newBlockMap }) {
  return sha256(JSON.stringify({
    url: String(url),
    sha512,
    size: plan.size,
    mode: plan.mode,
    operations: plan.operations.map((operation) => [
      operation.kind,
      operation.sourceStart,
      operation.sourceEnd,
      operation.outputStart,
      operation.outputEnd,
    ]),
    newBlockMapVersion: newBlockMap?.version || null,
  }))
}

function progressPayload({ mode, completedBytes, totalBytes, startedAt, now, details = {} }) {
  const elapsedSeconds = Math.max(0.001, (now() - startedAt) / 1000)
  return {
    status: 'downloading',
    mode,
    percent: totalBytes > 0 ? completedBytes / totalBytes * 100 : 100,
    transferred: completedBytes,
    total: totalBytes,
    bytesPerSecond: completedBytes / elapsedSeconds,
    ...details,
  }
}

export async function downloadUpdateArtifact({
  url,
  size,
  sha512,
  destinationPath,
  oldFilePath = null,
  oldBlockMap = null,
  newBlockMap = null,
  chunkSize = DEFAULT_UPDATE_CHUNK_SIZE,
  maxAttempts = DEFAULT_UPDATE_RANGE_ATTEMPTS,
  retryBaseMs = 500,
  fetchRange = fetchRangeBuffer,
  fetchImpl = globalThis.fetch,
  requestHeaders = {},
  idleTimeoutMs = DEFAULT_UPDATE_RANGE_IDLE_MS,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  now = Date.now,
  onStatus = () => {},
  signal,
} = {}) {
  if (!destinationPath || !sha512) throw updateError('update destination and sha512 are required', 'UPDATE_ARGUMENT_INVALID')
  const bounded = boundedChunkSize(chunkSize)
  let usableOldMap = oldBlockMap
  if (usableOldMap) {
    try {
      const oldStats = oldFilePath ? await fs.promises.stat(oldFilePath) : null
      if (!oldStats?.isFile() || oldStats.size !== blockMapSize(usableOldMap)) usableOldMap = null
    } catch {
      usableOldMap = null
    }
  }
  let plan
  try {
    plan = buildUpdatePlan({ size, oldBlockMap: usableOldMap, newBlockMap, chunkSize: bounded })
  } catch (error) {
    // A stale/corrupt/incompatible blockmap means there is no trustworthy
    // differential base. This is the only automatic transition to full mode;
    // transfer failures after a plan is selected never change modes.
    if (!String(error?.code || '').startsWith('UPDATE_BLOCKMAP_')) throw error
    plan = buildUpdatePlan({ size, chunkSize: bounded })
  }
  const fingerprint = planFingerprint({ url, sha512, plan, newBlockMap })
  const partialPath = `${destinationPath}.partial`
  const manifestPath = `${partialPath}.json`
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true })

  try {
    const existing = await fs.promises.stat(destinationPath)
    if (existing.isFile() && existing.size === plan.size && await hashFile(destinationPath) === sha512) {
      return { filePath: destinationPath, mode: plan.mode, resumed: true, downloadBytes: 0, size: plan.size }
    }
  } catch { /* no valid completed update */ }

  let manifest = await readJson(manifestPath)
  if (manifest?.fingerprint !== fingerprint) manifest = null
  const completed = manifest?.completed && typeof manifest.completed === 'object' ? { ...manifest.completed } : {}
  const previousPartial = await fs.promises.stat(partialPath).catch(() => null)
  const canResume = Boolean(manifest && previousPartial?.isFile() && previousPartial.size === plan.size)
  if (!canResume) {
    for (const key of Object.keys(completed)) delete completed[key]
  }

  const targetHandle = await fs.promises.open(partialPath, canResume ? 'r+' : 'w+')
  let sourceHandle = null
  const startedAt = now()
  let completedBytes = 0
  try {
    if (!canResume) await targetHandle.truncate(plan.size)
    if (plan.mode === 'differential') sourceHandle = await fs.promises.open(oldFilePath, 'r')
    for (const operation of plan.operations) {
      if (operation.kind === 'copy') await copyOperation(sourceHandle, targetHandle, operation, bounded)
    }

    for (const operation of plan.operations.filter((item) => item.kind === 'download')) {
      const key = rangeKey(operation)
      const length = operation.outputEnd - operation.outputStart
      const saved = completed[key]
      if (saved?.length === length) {
        const existing = await readAt(targetHandle, operation.outputStart, length)
        if (sha256(existing) === saved.sha256) {
          completedBytes += length
          continue
        }
        delete completed[key]
      }

      let buffer = null
      let lastError = null
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          buffer = await fetchRange({
            url,
            start: operation.sourceStart,
            end: operation.sourceEnd,
            fetchImpl,
            headers: requestHeaders,
            idleTimeoutMs,
            signal,
          })
          if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
          if (buffer.length !== length) {
            throw updateError(`update range length mismatch (${buffer.length}/${length})`, 'UPDATE_RANGE_MISMATCH')
          }
          break
        } catch (error) {
          lastError = error
          if (attempt >= maxAttempts) break
          const delayMs = retryBaseMs * (2 ** (attempt - 1))
          onStatus(progressPayload({
            mode: 'retrying', completedBytes, totalBytes: plan.downloadBytes, startedAt, now,
            details: { transferMode: plan.mode, attempt: attempt + 1, maxAttempts, delayMs, rangeStart: operation.sourceStart, rangeEnd: operation.sourceEnd },
          }))
          await sleep(delayMs)
        }
      }
      if (!buffer) {
        throw updateError(`update range failed after ${maxAttempts} attempts`, 'UPDATE_RANGE_RETRIES_EXHAUSTED', lastError)
      }
      await writeAt(targetHandle, operation.outputStart, buffer)
      completed[key] = { length, sha256: sha256(buffer) }
      completedBytes += length
      await writeJson(manifestPath, { fingerprint, completed })
      onStatus(progressPayload({ mode: plan.mode, completedBytes, totalBytes: plan.downloadBytes, startedAt, now }))
    }
    await targetHandle.sync()
  } finally {
    await sourceHandle?.close().catch(() => {})
    await targetHandle.close().catch(() => {})
  }

  const actualSha512 = await hashFile(partialPath)
  if (actualSha512 !== sha512) {
    await writeJson(manifestPath, { fingerprint, completed: {} })
    throw updateError('downloaded update failed sha512 verification', 'UPDATE_INTEGRITY_MISMATCH')
  }
  await fs.promises.rm(destinationPath, { force: true })
  await fs.promises.rename(partialPath, destinationPath)
  await fs.promises.rm(manifestPath, { force: true })
  return {
    filePath: destinationPath,
    mode: plan.mode,
    resumed: canResume,
    downloadBytes: plan.downloadBytes,
    size: plan.size,
  }
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase()
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]'
}

export function normalizeUpdateBaseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  let parsed
  try { parsed = new URL(raw) } catch { throw updateError('GUGO_UPDATE_BASE_URL is invalid', 'UPDATE_BASE_URL_INVALID') }
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)))) {
    throw updateError('GUGO_UPDATE_BASE_URL must use HTTPS (HTTP is allowed only for loopback)', 'UPDATE_BASE_URL_UNSAFE')
  }
  parsed.hash = ''
  parsed.search = ''
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.toString()
}

function selectInstallerFile(updater, updateInfo) {
  const provider = updater.updateInfoAndProvider?.provider
  const files = provider?.resolveFiles?.(updateInfo) || []
  const selected = files.find((file) => file?.url?.pathname?.toLowerCase().endsWith('.exe'))
  if (!selected?.url || !selected?.info?.sha512 || !selected?.info?.size) {
    throw updateError('release metadata does not contain a Windows installer', 'UPDATE_INSTALLER_MISSING')
  }
  return selected
}

function updateBlockMapUrl(installerUrl) {
  const result = new URL(installerUrl)
  result.pathname = `${result.pathname}.blockmap`
  result.search = ''
  result.hash = ''
  return result
}

export function createDesktopUpdateRuntime({
  updater,
  updateBaseUrl,
  onStatus = () => {},
  chunkSize = DEFAULT_UPDATE_CHUNK_SIZE,
  maxAttempts = DEFAULT_UPDATE_RANGE_ATTEMPTS,
  retryBaseMs = 500,
  fetchImpl = globalThis.fetch,
  fetchRange,
  sleep,
  now,
} = {}) {
  if (!updater) throw updateError('autoUpdater is required', 'UPDATE_ARGUMENT_INVALID')
  const configuredBaseUrl = normalizeUpdateBaseUrl(updateBaseUrl)
  if (configuredBaseUrl) updater.setFeedURL({ provider: 'generic', url: configuredBaseUrl, channel: 'latest' })
  let downloadPromise = null

  const startDownload = (updateInfo) => {
    if (downloadPromise) return downloadPromise
    downloadPromise = (async () => {
      const fileInfo = selectInstallerFile(updater, updateInfo)
      const helper = await updater.getOrCreateDownloadHelper()
      const pendingDirectory = helper.cacheDirForPendingUpdate
      const installerName = path.basename(decodeURIComponent(fileInfo.url.pathname))
      const destinationPath = path.join(pendingDirectory, installerName)
      const requestHeaders = updater.computeRequestHeaders?.(updater.updateInfoAndProvider?.provider) || {}
      let newBlockMap = null
      let newBlockMapBuffer = null
      try {
        newBlockMapBuffer = await fetchBufferWithRetry({
          url: updateBlockMapUrl(fileInfo.url), fetchImpl, headers: requestHeaders,
          maxAttempts, sleep: sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay))), retryBaseMs,
        })
        newBlockMap = parseBlockMap(newBlockMapBuffer)
      } catch { /* Missing blockmap is a supported resumable-full fallback. */ }
      const oldBlockMapPath = path.join(helper.cacheDir, 'current.blockmap')
      const oldInstallerPath = path.join(helper.cacheDir, 'installer.exe')
      const oldBlockMapBuffer = await fs.promises.readFile(oldBlockMapPath).catch(() => null)
      const oldBlockMap = oldBlockMapBuffer ? (() => { try { return parseBlockMap(oldBlockMapBuffer) } catch { return null } })() : null
      const result = await downloadUpdateArtifact({
        url: fileInfo.url,
        size: fileInfo.info.size,
        sha512: fileInfo.info.sha512,
        destinationPath,
        oldFilePath: oldInstallerPath,
        oldBlockMap,
        newBlockMap,
        chunkSize,
        maxAttempts,
        retryBaseMs,
        fetchImpl,
        ...(fetchRange ? { fetchRange } : {}),
        ...(sleep ? { sleep } : {}),
        ...(now ? { now } : {}),
        requestHeaders,
        onStatus: (status) => onStatus({ ...status, version: updateInfo.version }),
      })
      await fs.promises.mkdir(pendingDirectory, { recursive: true })
      if (newBlockMapBuffer) {
        const pendingBlockMapPath = path.join(pendingDirectory, 'current.blockmap')
        await fs.promises.writeFile(pendingBlockMapPath, newBlockMapBuffer)
        await fs.promises.copyFile(pendingBlockMapPath, path.join(helper.cacheDir, 'current.blockmap'))
      }
      await helper.setDownloadedFile(destinationPath, null, updateInfo, fileInfo, installerName, true)
      updater.dispatchUpdateDownloaded({ ...updateInfo, downloadedFile: destinationPath })
      updater.addQuitHandler()
      return result
    })().catch((error) => {
      onStatus({ status: 'error', mode: 'retrying', message: error?.message || 'update download failed', code: error?.code })
      throw error
    }).finally(() => {
      downloadPromise = null
    })
    return downloadPromise
  }

  const checkForUpdates = async () => {
    const result = await updater.checkForUpdates()
    if (result?.isUpdateAvailable && result.updateInfo) {
      void startDownload(result.updateInfo).catch(() => {})
    }
    return result
  }

  return Object.freeze({
    checkForUpdates,
    startDownload,
    get downloading() { return downloadPromise != null },
    updateBaseUrl: configuredBaseUrl,
  })
}
