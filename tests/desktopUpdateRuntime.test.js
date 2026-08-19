import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_UPDATE_CHUNK_SIZE,
  MIN_UPDATE_CHUNK_SIZE,
  buildUpdatePlan,
  createDesktopUpdateRuntime,
  downloadUpdateArtifact,
  normalizeUpdateBaseUrl,
} from '../desktop/updateRuntime.js'

const MIB = 1024 * 1024

function sha512(value) {
  return createHash('sha512').update(value).digest('base64')
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-desktop-update-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function blockMap({ checksums, sizes }) {
  return {
    version: '2',
    files: [{ name: 'installer.exe', offset: 0, checksums, sizes }],
  }
}

test('update range plans clamp chunks to the 1-4 MiB safety window', () => {
  const small = buildUpdatePlan({ size: 3 * MIB + 19, chunkSize: 1 })
  const large = buildUpdatePlan({ size: 9 * MIB + 19, chunkSize: 64 * MIB })
  const smallLengths = small.operations.map((operation) => operation.outputEnd - operation.outputStart)
  const largeLengths = large.operations.map((operation) => operation.outputEnd - operation.outputStart)

  assert.equal(Math.max(...smallLengths), MIN_UPDATE_CHUNK_SIZE)
  assert.equal(Math.max(...largeLengths), MAX_UPDATE_CHUNK_SIZE)
  assert.ok(smallLengths.every((length) => length > 0 && length <= MIN_UPDATE_CHUNK_SIZE))
  assert.ok(largeLengths.every((length) => length > 0 && length <= MAX_UPDATE_CHUNK_SIZE))
})

test('an interrupted transfer keeps completed chunks and resumes only missing ranges', async (t) => {
  const directory = temporaryDirectory(t)
  const destinationPath = path.join(directory, 'Gugo-Setup.exe')
  const payload = Buffer.alloc(3 * MIB + 37, 0x5a)
  const firstRequests = []

  await assert.rejects(
    downloadUpdateArtifact({
      url: new URL('https://updates.example/Gugo-Setup.exe'),
      size: payload.length,
      sha512: sha512(payload),
      destinationPath,
      chunkSize: MIB,
      maxAttempts: 1,
      fetchRange: async ({ start, end }) => {
        firstRequests.push([start, end])
        if (start >= MIB) throw new Error('simulated disconnect')
        return payload.subarray(start, end)
      },
    }),
    { code: 'UPDATE_RANGE_RETRIES_EXHAUSTED' },
  )

  assert.deepEqual(firstRequests, [[0, MIB], [MIB, 2 * MIB]])
  assert.equal(fs.existsSync(`${destinationPath}.partial`), true)
  assert.equal(fs.existsSync(`${destinationPath}.partial.json`), true)

  const resumedRequests = []
  const result = await downloadUpdateArtifact({
    url: new URL('https://updates.example/Gugo-Setup.exe'),
    size: payload.length,
    sha512: sha512(payload),
    destinationPath,
    chunkSize: MIB,
    maxAttempts: 1,
    fetchRange: async ({ start, end }) => {
      resumedRequests.push([start, end])
      return payload.subarray(start, end)
    },
  })

  assert.equal(result.resumed, true)
  assert.ok(resumedRequests.length > 0)
  assert.ok(resumedRequests.every(([start]) => start >= MIB))
  assert.deepEqual(fs.readFileSync(destinationPath), payload)
  assert.equal(fs.existsSync(`${destinationPath}.partial.json`), false)
})

test('a differential chunk exhausts three retries without falling back to a full installer', async (t) => {
  const directory = temporaryDirectory(t)
  const oldFilePath = path.join(directory, 'installer.exe')
  const destinationPath = path.join(directory, 'pending', 'Gugo-Setup.exe')
  const oldPayload = Buffer.concat([Buffer.alloc(MIB, 0x11), Buffer.alloc(MIB, 0x22)])
  const newPayload = Buffer.concat([oldPayload.subarray(0, MIB), Buffer.alloc(MIB, 0x33)])
  fs.writeFileSync(oldFilePath, oldPayload)
  const requests = []
  const statuses = []

  await assert.rejects(
    downloadUpdateArtifact({
      url: new URL('https://updates.example/Gugo-Setup.exe'),
      size: newPayload.length,
      sha512: sha512(newPayload),
      destinationPath,
      oldFilePath,
      oldBlockMap: blockMap({ checksums: ['same', 'old'], sizes: [MIB, MIB] }),
      newBlockMap: blockMap({ checksums: ['same', 'new'], sizes: [MIB, MIB] }),
      chunkSize: MIB,
      maxAttempts: 3,
      retryBaseMs: 1,
      sleep: async () => {},
      onStatus: (status) => statuses.push(status),
      fetchRange: async ({ start, end }) => {
        requests.push([start, end])
        throw new Error('range unavailable')
      },
    }),
    { code: 'UPDATE_RANGE_RETRIES_EXHAUSTED' },
  )

  assert.deepEqual(requests, [
    [MIB, 2 * MIB],
    [MIB, 2 * MIB],
    [MIB, 2 * MIB],
  ])
  assert.equal(statuses.length, 2)
  assert.ok(statuses.every((status) => status.mode === 'retrying'))
  assert.ok(statuses.every((status) => status.transferMode === 'differential'))
  assert.equal(fs.existsSync(`${destinationPath}.partial`), true)
})

test('a missing differential base uses resumable full mode and reports it', async (t) => {
  const directory = temporaryDirectory(t)
  const destinationPath = path.join(directory, 'Gugo-Setup.exe')
  const payload = Buffer.alloc(2 * MIB, 0x47)
  const requests = []
  const statuses = []

  const result = await downloadUpdateArtifact({
    url: new URL('https://updates.example/Gugo-Setup.exe'),
    size: payload.length,
    sha512: sha512(payload),
    destinationPath,
    oldFilePath: path.join(directory, 'missing-installer.exe'),
    oldBlockMap: blockMap({ checksums: ['same', 'old'], sizes: [MIB, MIB] }),
    newBlockMap: blockMap({ checksums: ['same', 'new'], sizes: [MIB, MIB] }),
    chunkSize: MIB,
    maxAttempts: 1,
    onStatus: (status) => statuses.push(status),
    fetchRange: async ({ start, end }) => {
      requests.push([start, end])
      return payload.subarray(start, end)
    },
  })

  assert.equal(result.mode, 'full')
  assert.equal(requests[0][0], 0)
  assert.ok(statuses.some((status) => status.mode === 'full'))
  assert.deepEqual(fs.readFileSync(destinationPath), payload)
})

test('incompatible blockmaps are treated as an unavailable base and use full mode', async (t) => {
  const directory = temporaryDirectory(t)
  const oldFilePath = path.join(directory, 'installer.exe')
  const destinationPath = path.join(directory, 'Gugo-Setup.exe')
  const payload = Buffer.alloc(2 * MIB, 0x4f)
  fs.writeFileSync(oldFilePath, Buffer.alloc(payload.length, 0x12))
  const oldBlockMap = blockMap({ checksums: ['same', 'old'], sizes: [MIB, MIB] })
  const newBlockMap = blockMap({ checksums: ['same', 'new'], sizes: [MIB, MIB] })
  oldBlockMap.version = '1'
  const requests = []

  const result = await downloadUpdateArtifact({
    url: new URL('https://updates.example/Gugo-Setup.exe'),
    size: payload.length,
    sha512: sha512(payload),
    destinationPath,
    oldFilePath,
    oldBlockMap,
    newBlockMap,
    chunkSize: MIB,
    maxAttempts: 1,
    fetchRange: async ({ start, end }) => {
      requests.push([start, end])
      return payload.subarray(start, end)
    },
  })

  assert.equal(result.mode, 'full')
  assert.equal(requests[0][0], 0)
  assert.deepEqual(fs.readFileSync(destinationPath), payload)
})

test('SHA-512 mismatch rejects completion and retains a resumable partial file', async (t) => {
  const directory = temporaryDirectory(t)
  const destinationPath = path.join(directory, 'Gugo-Setup.exe')
  const payload = Buffer.alloc(MIB, 0x66)

  await assert.rejects(
    downloadUpdateArtifact({
      url: new URL('https://updates.example/Gugo-Setup.exe'),
      size: payload.length,
      sha512: sha512(Buffer.from('different installer')),
      destinationPath,
      chunkSize: MIB,
      maxAttempts: 1,
      fetchRange: async ({ start, end }) => payload.subarray(start, end),
    }),
    { code: 'UPDATE_INTEGRITY_MISMATCH' },
  )

  assert.equal(fs.existsSync(destinationPath), false)
  assert.equal(fs.existsSync(`${destinationPath}.partial`), true)
  const manifest = JSON.parse(fs.readFileSync(`${destinationPath}.partial.json`, 'utf8'))
  assert.deepEqual(manifest.completed, {})
})

test('desktop update source accepts HTTPS and loopback HTTP only', () => {
  assert.equal(normalizeUpdateBaseUrl(''), null)
  assert.equal(normalizeUpdateBaseUrl('https://downloads.example/gugo'), 'https://downloads.example/gugo/')
  assert.equal(normalizeUpdateBaseUrl('http://127.0.0.1:8080/releases?token=discarded#x'), 'http://127.0.0.1:8080/releases/')
  assert.throws(() => normalizeUpdateBaseUrl('http://downloads.example/gugo'), { code: 'UPDATE_BASE_URL_UNSAFE' })
  assert.throws(() => normalizeUpdateBaseUrl('file:///C:/updates'), { code: 'UPDATE_BASE_URL_UNSAFE' })
  assert.throws(() => normalizeUpdateBaseUrl('https://user:password@downloads.example/gugo'), { code: 'UPDATE_BASE_URL_UNSAFE' })
  assert.throws(() => normalizeUpdateBaseUrl('not a URL'), { code: 'UPDATE_BASE_URL_INVALID' })
})

test('custom runtime registers the verified installer with electron-updater for NSIS install', async (t) => {
  const directory = temporaryDirectory(t)
  const pendingDirectory = path.join(directory, 'pending')
  const payload = Buffer.alloc(128 * 1024, 0x21)
  const updateInfo = { version: '9.9.9' }
  const fileInfo = {
    url: new URL('https://downloads.example/Gugo-Setup-9.9.9-x64.exe'),
    info: { size: payload.length, sha512: sha512(payload) },
  }
  const calls = { downloaded: [], dispatched: [], feed: [], quit: 0 }
  const helper = {
    cacheDir: directory,
    cacheDirForPendingUpdate: pendingDirectory,
    async setDownloadedFile(...args) { calls.downloaded.push(args) },
  }
  const provider = { resolveFiles: () => [fileInfo] }
  const updater = {
    updateInfoAndProvider: { provider, info: updateInfo },
    setFeedURL(value) { calls.feed.push(value) },
    async getOrCreateDownloadHelper() { return helper },
    computeRequestHeaders() { return { authorization: 'Bearer test' } },
    dispatchUpdateDownloaded(value) { calls.dispatched.push(value) },
    addQuitHandler() { calls.quit += 1 },
  }
  const statuses = []
  const runtime = createDesktopUpdateRuntime({
    updater,
    updateBaseUrl: 'https://downloads.example/gugo',
    maxAttempts: 1,
    fetchImpl: async () => new Response('missing blockmap', { status: 404 }),
    fetchRange: async ({ start, end }) => payload.subarray(start, end),
    onStatus: (status) => statuses.push(status),
  })

  const result = await runtime.startDownload(updateInfo)

  assert.equal(result.mode, 'full')
  assert.deepEqual(calls.feed, [{ provider: 'generic', url: 'https://downloads.example/gugo/', channel: 'latest' }])
  assert.equal(calls.downloaded.length, 1)
  const [downloadedPath, packageFile, registeredInfo, registeredFile, installerName, saveCache] = calls.downloaded[0]
  assert.deepEqual(fs.readFileSync(downloadedPath), payload)
  assert.equal(packageFile, null)
  assert.equal(registeredInfo, updateInfo)
  assert.equal(registeredFile, fileInfo)
  assert.equal(installerName, 'Gugo-Setup-9.9.9-x64.exe')
  assert.equal(saveCache, true)
  assert.equal(calls.dispatched[0].downloadedFile, downloadedPath)
  assert.equal(calls.quit, 1)
  assert.ok(statuses.some((status) => status.mode === 'full' && status.version === '9.9.9'))
})
