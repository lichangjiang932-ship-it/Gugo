import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  downloadFromBrowserElement,
  publishBrowserDownload,
  waitForBrowserDownload,
} from '../server/adapters/browserDownloadAutomation.js'
import { classifyToolRisk } from '../server/utils/approvalPolicy.js'
import { isLocalMutationCall } from '../server/services/loop/heuristics/mutationClassification.js'
import { localArtifactCandidates } from '../server/services/loop/heuristics/toolSelection.js'

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-browser-download-'))
}

test('browser download waits for the partial file to become one completed bounded file', async () => {
  const directory = temporaryDirectory()
  const partial = path.join(directory, 'report.pdf.crdownload')
  const complete = path.join(directory, 'report.pdf')
  try {
    fs.writeFileSync(partial, 'partial')
    const finish = setTimeout(() => fs.renameSync(partial, complete), 30)
    const result = await waitForBrowserDownload({
      directory,
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    clearTimeout(finish)
    assert.equal(result.sourcePath, fs.realpathSync(complete))
    assert.equal(result.filename, 'report.pdf')
    assert.equal(result.bytes, Buffer.byteLength('partial'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('browser download rejects oversized, ambiguous, and symlink outcomes', async (t) => {
  const oversized = temporaryDirectory()
  const multiple = temporaryDirectory()
  const linked = temporaryDirectory()
  try {
    fs.writeFileSync(path.join(oversized, 'large.bin'), Buffer.alloc(20))
    await assert.rejects(waitForBrowserDownload({
      directory: oversized, timeoutMs: 1_000, maxBytes: 10,
    }), { code: 'BROWSER_DOWNLOAD_TOO_LARGE' })

    fs.writeFileSync(path.join(multiple, 'one.bin'), 'one')
    fs.writeFileSync(path.join(multiple, 'two.bin'), 'two')
    await assert.rejects(waitForBrowserDownload({
      directory: multiple, timeoutMs: 1_000,
    }), { code: 'BROWSER_DOWNLOAD_MULTIPLE_FILES' })

    const source = path.join(linked, 'source.bin')
    const link = path.join(linked, 'link.bin')
    fs.writeFileSync(source, 'source')
    try {
      fs.symlinkSync(source, link)
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.diagnostic('symlink creation is unavailable on this Windows host')
        return
      }
      throw error
    }
    await assert.rejects(waitForBrowserDownload({
      directory: linked, timeoutMs: 1_000,
    }), { code: 'BROWSER_DOWNLOAD_UNSAFE_FILE' })
  } finally {
    fs.rmSync(oversized, { recursive: true, force: true })
    fs.rmSync(multiple, { recursive: true, force: true })
    fs.rmSync(linked, { recursive: true, force: true })
  }
})

test('browser download enables one staging directory, clicks by deep ref, and disables downloads afterward', async () => {
  const directory = temporaryDirectory()
  const calls = []
  const session = {
    sessionId: null,
    client: {
      async request(method, params) {
        calls.push({ method, params })
        if (method === 'Runtime.evaluate') {
          setTimeout(() => fs.writeFileSync(path.join(directory, 'download.txt'), 'downloaded'), 20)
          return { result: { value: { ok: true } } }
        }
        return {}
      },
    },
  }
  try {
    const result = await downloadFromBrowserElement(session, {
      target: 'e7',
      stagingDirectory: directory,
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    assert.equal(result.filename, 'download.txt')
    assert.deepEqual(calls.map((call) => call.method), [
      'Page.setDownloadBehavior', 'Runtime.evaluate', 'Page.setDownloadBehavior',
    ])
    assert.deepEqual(calls[0].params, { behavior: 'allow', downloadPath: directory })
    assert.equal(calls[2].params.behavior, 'deny')
    assert.match(calls[1].params.expression, /data-yma-ref/)
    assert.match(calls[1].params.expression, /e7/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('browser download publishes atomically, protects existing targets, and reports SHA-256', async () => {
  const directory = temporaryDirectory()
  const source = path.join(directory, 'staged.bin')
  const destination = path.join(directory, 'final.bin')
  try {
    fs.writeFileSync(source, 'first')
    const first = await publishBrowserDownload({ sourcePath: source, destination })
    assert.equal(fs.readFileSync(destination, 'utf8'), 'first')
    assert.equal(first.bytes, 5)
    assert.equal(first.sha256, 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e')

    fs.writeFileSync(source, 'second')
    await assert.rejects(
      publishBrowserDownload({ sourcePath: source, destination }),
      { code: 'BROWSER_DOWNLOAD_TARGET_EXISTS' },
    )
    assert.equal(fs.readFileSync(destination, 'utf8'), 'first')

    const replaced = await publishBrowserDownload({
      sourcePath: source, destination, overwrite: true,
    })
    assert.equal(fs.readFileSync(destination, 'utf8'), 'second')
    assert.equal(replaced.bytes, 6)
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.gugo-browser-download-')), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('browser download is a high-risk authenticated web write with local mutation evidence', () => {
  const call = { name: 'browser_download', args: { target: 'e7', path: 'output/report.pdf' } }
  const verdict = classifyToolRisk(call.name, call.args, {
    origin: 'chat', mode: 'unattended', permissionMode: 'normal',
  })
  assert.equal(verdict.needsApproval, true)
  assert.equal(verdict.risk, 'high')
  assert.match(verdict.reason, /下载.*写入/u)
  assert.equal(isLocalMutationCall(call), true)
  assert.deepEqual(localArtifactCandidates(call, {
    path: 'output/report.pdf', scope: 'grant',
  }), [{ path: 'output/report.pdf', scope: 'grant' }])
})
