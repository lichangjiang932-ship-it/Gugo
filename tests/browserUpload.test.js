import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { _browserInternals } from '../server/adapters/browserAutomation.js'
import { closeDb, createUser } from '../server/db.js'
import { executeBrowserTool, resolveBrowserUploadFile } from '../server/services/browserToolExecutor.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'
import { classifyToolRisk } from '../server/utils/approvalPolicy.js'

const userId = 'browser-upload-owner'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-browser-upload-'))
createUser({ id: userId, email: 'browser-upload@example.test' })
grantLocalPath({ userId, rootPath: root, accessMode: 'read_only' })

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('browser upload accepts only an authorized regular file within its size boundary', () => {
  const file = path.join(root, 'upload.txt')
  fs.writeFileSync(file, 'upload fixture')
  assert.deepEqual(resolveBrowserUploadFile({ userId, rawPath: file }), {
    path: fs.realpathSync(file),
    size: Buffer.byteLength('upload fixture'),
  })
  assert.throws(() => resolveBrowserUploadFile({ userId, rawPath: root }), {
    code: 'BROWSER_UPLOAD_FILE_REQUIRED',
  })

  const tooLarge = path.join(root, 'too-large.bin')
  const descriptor = fs.openSync(tooLarge, 'w')
  try { fs.ftruncateSync(descriptor, 100 * 1024 * 1024 + 1) } finally { fs.closeSync(descriptor) }
  assert.throws(() => resolveBrowserUploadFile({ userId, rawPath: tooLarge }), {
    code: 'BROWSER_UPLOAD_TOO_LARGE',
  })
})

test('browser upload refuses a local path outside the user authorization boundary', () => {
  const outside = path.join(os.tmpdir(), `gugo-browser-upload-outside-${process.pid}.txt`)
  try {
    fs.writeFileSync(outside, 'private fixture')
    assert.throws(() => resolveBrowserUploadFile({ userId, rawPath: outside }), {
      code: 'PATH_NOT_AUTHORIZED',
    })
  } finally {
    fs.rmSync(outside, { force: true })
  }
})

test('CDP file binding uses a node object and releases it after dispatching input events', async () => {
  const calls = []
  const session = {
    sessionId: null,
    client: {
      async request(method, params) {
        calls.push({ method, params })
        if (method === 'Runtime.evaluate' && calls.length === 1) {
          return { result: { objectId: 'file-input-object' } }
        }
        if (method === 'Runtime.evaluate') return { result: { value: { ok: true, count: 1 } } }
        return {}
      },
    },
  }
  const file = path.join(root, 'upload.txt')
  await _browserInternals.setBrowserFileInput(session, { target: 'e4', filePath: file })
  assert.deepEqual(calls.map((entry) => entry.method), [
    'Runtime.evaluate', 'DOM.setFileInputFiles', 'Runtime.evaluate', 'Runtime.releaseObject',
  ])
  assert.deepEqual(calls[1].params, { files: [file], objectId: 'file-input-object' })
  assert.deepEqual(calls[3].params, { objectId: 'file-input-object' })
  assert.match(calls[0].params.expression, /HTMLInputElement/)
  assert.match(calls[2].params.expression, /dispatchEvent/)
})

test('browser download rejects an unauthorized destination before starting a browser session', async () => {
  const outside = path.join(os.tmpdir(), `gugo-browser-download-outside-${process.pid}.bin`)
  await assert.rejects(
    executeBrowserTool('browser_download', {
      target: 'e7', path: outside,
    }, { userId }),
    { code: 'PATH_NOT_AUTHORIZED' },
  )
  assert.equal(fs.existsSync(outside), false)
})

test('browser file upload is an explicit high-risk web side effect', () => {
  const verdict = classifyToolRisk('browser_upload_file', {
    target: 'e4', path: path.join(root, 'upload.txt'),
  }, { origin: 'chat', mode: 'unattended', permissionMode: 'normal' })
  assert.equal(verdict.needsApproval, true)
  assert.equal(verdict.risk, 'high')
  assert.match(verdict.reason, /本地文件|网页/u)
})
