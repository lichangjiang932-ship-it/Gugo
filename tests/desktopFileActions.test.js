import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { executeDesktopFileAction, registerDesktopFileIpc } from '../desktop/fileActions.js'
import { createDesktopFileActionSetup } from '../desktop/fileActionSetup.js'
import { desktopFileOpenPolicy, desktopFileReferenceFromUrl } from '../shared/desktopFileReference.js'
import { desktopFileStatFingerprint, signDesktopFileMessage, verifyDesktopFileMessage } from '../server/utils/desktopFileProtocol.js'

const secret = 'a'.repeat(64)
const origin = 'http://127.0.0.1:54321'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-desktop-file-actions-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
let sequence = 0

function unsignedMessage(message) {
  const unsigned = { ...message }
  delete unsigned.signature
  return unsigned
}

function resign(message, patch) {
  return signDesktopFileMessage({ ...unsignedMessage(message), ...patch }, secret)
}

function fixture({ extension = 'txt', directory = root, responseTransform, afterResponse, shellError = '' } = {}) {
  const fullPath = path.join(directory, `file-${++sequence}.${extension}`)
  fs.writeFileSync(fullPath, 'synthetic file body')
  const calls = { requests: [], opened: [], revealed: [] }
  const payload = { action: 'open', reference: { kind: 'artifact', filename: path.basename(fullPath) }, authToken: 'synthetic-owner-token' }
  const options = {
    applicationOrigin: origin, secret,
    shellImpl: {
      openPath: async (value) => { calls.opened.push(value); return shellError },
      showItemInFolder: (value) => calls.revealed.push(value),
    },
    fetchImpl: async (url, init) => {
      calls.requests.push({ url, init })
      const request = verifyDesktopFileMessage(JSON.parse(init.body), secret)
      const target = { fullPath: fs.realpathSync(fullPath), filename: path.basename(fullPath), fingerprint: desktopFileStatFingerprint(fs.statSync(fullPath, { bigint: true })) }
      const result = signDesktopFileMessage({ ok: true, nonce: request.nonce, issuedAt: request.issuedAt, action: request.action, target }, secret)
      const body = responseTransform ? responseTransform(result, request) : result
      afterResponse?.()
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    },
  }
  return { payload, options, calls, fullPath }
}

test('desktop references only project same-origin owned artifact and receipt URLs, never raw paths or credentials', () => {
  assert.deepEqual(desktopFileReferenceFromUrl('/api/local-files/verified/file-1?turnId=turn-1&preview=1&token=unused', origin), {
    kind: 'verified', fileId: 'file-1', turnId: 'turn-1',
  })
  assert.deepEqual(desktopFileReferenceFromUrl('/api/artifacts/report%20final.pdf', origin), { kind: 'artifact', filename: 'report final.pdf' })
  for (const url of ['file:///C:/private.txt', 'C:\\private.txt', '/api/artifacts/../private.txt',
    'https://external.invalid/api/artifacts/report.pdf', 'http://user:pass@127.0.0.1:54321/api/artifacts/report.pdf',
    '/api/local-files/verified/file?turnId=a&turnId=b', '/api/local-files/verified/file', '/api/artifacts/%2fprivate.txt']) {
    assert.equal(desktopFileReferenceFromUrl(url, origin), null, url)
  }
})

test('desktop opening allowlist excludes executable, script, shortcut and macro types', () => {
  for (const name of ['program.exe', 'run.cmd', 'run.ps1', 'run.js', 'run.py', 'run.sh', 'shortcut.lnk', 'site.url',
    'shell.desktop', 'sheet.xlsm', 'slides.pptm', 'report.docm', 'report.pdf ', 'fake\u202eexe.pdf']) {
    assert.equal(desktopFileOpenPolicy(name).allowed, false, name)
  }
  assert.deepEqual(desktopFileOpenPolicy('page.html'), { allowed: true, confirm: true })
  assert.deepEqual(desktopFileOpenPolicy('report.pdf'), { allowed: true, confirm: false })
})

test('desktop opens and reveals only metadata signed by the actual local service', async () => {
  const { payload, options, calls, fullPath } = fixture()
  assert.deepEqual(await executeDesktopFileAction(payload, options), { ok: true, canceled: false, action: 'open' })
  assert.deepEqual(await executeDesktopFileAction({ ...payload, action: 'reveal' }, options), { ok: true, canceled: false, action: 'reveal' })
  assert.deepEqual(calls.opened, [fs.realpathSync(fullPath)])
  assert.deepEqual(calls.revealed, [fs.realpathSync(fullPath)])
  for (const request of calls.requests) {
    assert.equal(request.url, `${origin}/api/local-files/desktop-target`)
    assert.equal(request.init.redirect, 'error')
    assert.equal(request.init.headers.Authorization, 'Bearer synthetic-owner-token')
    assert.equal(request.init.body.includes(secret), false)
    assert.equal(request.init.body.includes(fullPath), false)
  }
})

test('desktop accepts service-signed Windows path casing without weakening file identity', { skip: process.platform !== 'win32' }, async () => {
  const value = fixture({ responseTransform: (message) => resign(message, {
    target: { ...message.target, fullPath: message.target.fullPath.toLowerCase() },
  }) })
  const servicePath = fs.realpathSync(value.fullPath.toLowerCase())
  assert.notEqual(servicePath, await fs.promises.realpath(servicePath), 'the native API expands a different path spelling')
  assert.deepEqual(await executeDesktopFileAction(value.payload, value.options), { ok: true, canceled: false, action: 'open' })
  assert.deepEqual(value.calls.opened, [servicePath])
})

test('desktop accepts a real Windows 8.3 alias from the signed service without changing its fingerprint', { skip: process.platform !== 'win32' }, async (t) => {
  let servicePath
  const value = fixture({ responseTransform: (message) => resign(message, {
    target: { ...message.target, fullPath: servicePath, filename: path.basename(servicePath) },
  }) })
  const shortPath = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'for %I in ("%GUGO_TEST_FILE_PATH%") do @echo %~sI'], {
    env: { ...process.env, GUGO_TEST_FILE_PATH: value.fullPath }, encoding: 'utf8',
    windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
  }).trim()
  servicePath = fs.realpathSync(shortPath)
  if (!/(?:^|[\\/])[^\\/]*~[0-9]/u.test(servicePath)) {
    t.skip('this Windows volume does not generate an 8.3 alias for the isolated fixture')
    return
  }
  assert.notEqual(servicePath, await fs.promises.realpath(servicePath))
  assert.equal(desktopFileStatFingerprint(fs.statSync(servicePath, { bigint: true })),
    desktopFileStatFingerprint(fs.statSync(value.fullPath, { bigint: true })))
  await executeDesktopFileAction(value.payload, value.options)
  await executeDesktopFileAction({ ...value.payload, action: 'reveal' }, value.options)
  assert.deepEqual(value.calls.opened, [servicePath])
  assert.deepEqual(value.calls.revealed, [servicePath])
})

test('unsigned, substituted-service, stale, wrong-nonce and tampered metadata never reach native APIs', async () => {
  const invalidReplies = [
    unsignedMessage,
    (message) => ({ ...message, signature: '0'.repeat(64) }),
    (message) => resign(message, { nonce: 'b'.repeat(32) }),
    (message) => ({ ...message, target: { ...message.target, fullPath: path.join(root, 'other.txt') } }),
    (message) => resign(message, { issuedAt: Date.now() - 60_000 }),
    (message) => resign(message, { action: 'reveal' }),
  ]
  for (const responseTransform of invalidReplies) {
    const { payload, options, calls } = fixture({ responseTransform })
    await assert.rejects(executeDesktopFileAction(payload, options), { code: 'DESKTOP_FILE_SERVICE_UNTRUSTED' })
    assert.equal(calls.opened.length + calls.revealed.length, 0)
  }
})

test('invalid actions, raw paths, remote origins and missing auth fail before any request', async () => {
  for (const patch of [{ action: 'shell' }, { reference: { path: 'C:\\private.txt' } }, { authToken: '' }, { authToken: 'bad\nheader' }]) {
    const { payload, options, calls } = fixture()
    await assert.rejects(executeDesktopFileAction({ ...payload, ...patch }, options))
    assert.equal(calls.requests.length, 0)
  }
  for (const applicationOrigin of ['https://outside.invalid', 'file:///C:/index.html', 'http://user:pass@127.0.0.1']) {
    const { payload, options, calls } = fixture()
    await assert.rejects(executeDesktopFileAction(payload, { ...options, applicationOrigin }), { code: 'DESKTOP_FILE_SERVICE_UNTRUSTED' })
    assert.equal(calls.requests.length, 0)
  }
})

test('file replacement and nonregular paths are rejected just before opening', async () => {
  const changed = fixture()
  const fetchImpl = changed.options.fetchImpl
  changed.options.fetchImpl = async (...args) => {
    const response = await fetchImpl(...args)
    fs.appendFileSync(changed.fullPath, ' changed')
    return response
  }
  await assert.rejects(executeDesktopFileAction(changed.payload, changed.options), { code: 'DESKTOP_FILE_CHANGED' })
  assert.deepEqual(changed.calls.opened, [])
  const device = fixture({ responseTransform: (message) => {
    return resign(message, { target: { fullPath: '\\\\.\\NUL', filename: 'NUL', fingerprint: 'fake' } })
  } })
  await assert.rejects(executeDesktopFileAction(device.payload, device.options), { code: 'DESKTOP_FILE_PATH_INVALID' })
  assert.deepEqual(device.calls.opened, [])
})

test('same-size replacements with restored modification time still fail the exact file fingerprint check', async () => {
  const value = fixture()
  const fixedTime = 1_700_000_000
  fs.utimesSync(value.fullPath, fixedTime, fixedTime)
  const previousStat = fs.statSync(value.fullPath, { bigint: true })
  const fetchImpl = value.options.fetchImpl
  value.options.fetchImpl = async (...args) => {
    const response = await fetchImpl(...args)
    fs.renameSync(value.fullPath, `${value.fullPath}.previous`)
    fs.writeFileSync(value.fullPath, 'synthetic file body')
    fs.utimesSync(value.fullPath, fixedTime, fixedTime)
    const replacementStat = fs.statSync(value.fullPath, { bigint: true })
    assert.equal(replacementStat.size, previousStat.size)
    assert.equal(replacementStat.mtimeNs, previousStat.mtimeNs)
    assert.notEqual(replacementStat.ino, previousStat.ino)
    return response
  }
  await assert.rejects(executeDesktopFileAction(value.payload, value.options), { code: 'DESKTOP_FILE_CHANGED' })
  assert.deepEqual(value.calls.opened, [])
})

test('a parent directory replaced by a junction after signing cannot redirect the native action', async () => {
  const original = path.join(root, 'junction-original')
  const replacement = path.join(root, 'junction-replacement')
  fs.mkdirSync(original)
  fs.mkdirSync(replacement)
  const value = fixture({ directory: original })
  fs.writeFileSync(path.join(replacement, path.basename(value.fullPath)), 'synthetic file body')
  const fetchImpl = value.options.fetchImpl
  value.options.fetchImpl = async (...args) => {
    const response = await fetchImpl(...args)
    fs.renameSync(original, `${original}.previous`)
    fs.symlinkSync(replacement, original, process.platform === 'win32' ? 'junction' : 'dir')
    return response
  }
  await assert.rejects(executeDesktopFileAction(value.payload, value.options), { code: 'DESKTOP_FILE_CHANGED' })
  assert.deepEqual(value.calls.opened, [])
})

test('HTML external-open confirmation defaults to cancel and rechecks permissions and version after approval', async () => {
  const canceled = fixture({ extension: 'html' })
  assert.equal((await executeDesktopFileAction(canceled.payload, canceled.options)).canceled, true)
  assert.equal(canceled.calls.requests.length, 1)
  assert.deepEqual(canceled.calls.opened, [])
  const approved = fixture({ extension: 'html' })
  assert.equal((await executeDesktopFileAction(approved.payload, { ...approved.options, confirmOpen: async () => true })).canceled, false)
  assert.equal(approved.calls.requests.length, 2)
  assert.equal(approved.calls.opened.length, 1)
  const changed = fixture({ extension: 'html' })
  await assert.rejects(executeDesktopFileAction(changed.payload, {
    ...changed.options,
    confirmOpen: async () => { fs.appendFileSync(changed.fullPath, 'changed while confirming'); return true },
  }), { code: 'DESKTOP_FILE_CHANGED' })
  assert.deepEqual(changed.calls.opened, [])
})

test('signed unsafe extensions and OS-open failures are still failures, not success', async () => {
  const unsafe = fixture({ extension: 'cmd' })
  await assert.rejects(executeDesktopFileAction(unsafe.payload, unsafe.options), { code: 'DESKTOP_FILE_OPEN_UNSAFE' })
  assert.deepEqual(unsafe.calls.opened, [])
  const failure = fixture({ shellError: 'synthetic missing default app' })
  await assert.rejects(executeDesktopFileAction(failure.payload, failure.options), { code: 'DESKTOP_FILE_OPEN_FAILED' })
})

function ipcFixture(options = {}) {
  const value = fixture(options)
  const frame = { url: `${origin}/chat` }
  const contents = { mainFrame: frame }
  const context = { mainWindow: { isDestroyed: () => false, webContents: contents }, applicationOrigin: origin, secret }
  let handler
  registerDesktopFileIpc({ ...value.options, ipcMain: { handle: (_channel, callback) => { handler = callback } }, getContext: () => context })
  return { ...value, handler, context, event: { sender: contents, senderFrame: frame } }
}

test('desktop IPC rejects sibling windows, subframes, mismatched origins and destroyed windows', async () => {
  for (const mutate of [
    (value) => { value.event.sender = {} },
    (value) => { value.event.senderFrame = { url: `${origin}/chat` } },
    (value) => { value.event.senderFrame.url = 'https://external.invalid/' },
    (value) => { value.context.mainWindow.isDestroyed = () => true },
  ]) {
    const value = ipcFixture()
    mutate(value)
    const result = await value.handler(value.event, value.payload)
    assert.equal(result.error.code, 'DESKTOP_FILE_SENDER_UNTRUSTED')
    assert.equal(value.calls.requests.length, 0)
  }
})

test('navigation away during file resolution revokes the pending native action', async () => {
  let value
  value = ipcFixture({ afterResponse: () => { value.event.senderFrame.url = 'https://external.invalid/' } })
  assert.equal((await value.handler(value.event, value.payload)).error.code, 'DESKTOP_FILE_SENDER_UNTRUSTED')
  assert.deepEqual(value.calls.opened, [])
})

test('desktop IPC permits only one pending native action and recovers after completion', async () => {
  const value = ipcFixture()
  const fetchImpl = value.options.fetchImpl
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  let handler
  registerDesktopFileIpc({
    ...value.options,
    fetchImpl: async (...args) => { entered(); await waiting; return fetchImpl(...args) },
    ipcMain: { handle: (_channel, callback) => { handler = callback } }, getContext: () => value.context,
  })
  const first = handler(value.event, value.payload)
  await started
  assert.equal((await handler(value.event, value.payload)).error.code, 'DESKTOP_FILE_ACTION_PENDING')
  release()
  assert.equal((await first).ok, true)
  assert.equal((await handler(value.event, { ...value.payload, action: 'reveal' })).ok, true)
  assert.equal(value.calls.opened.length, 1)
  assert.equal(value.calls.revealed.length, 1)
})

test('desktop setup creates an ephemeral bridge key and owns the explicit cancel-by-default file confirmation', async () => {
  const generated = createDesktopFileActionSetup({ env: {} })
  assert.match(generated.secret, /^[a-f0-9]{64}$/u)
  for (const locale of ['zh-CN', 'en-US']) {
    const value = fixture({ extension: 'html' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = value.options.fetchImpl
    const frame = { url: `${origin}/chat` }
    const contents = { mainFrame: frame }
    const context = { mainWindow: { isDestroyed: () => false, webContents: contents }, applicationOrigin: origin }
    let handler
    const confirmations = []
    const setup = createDesktopFileActionSetup({
      app: { getLocale: () => locale },
      dialog: { showMessageBox: async (window, options) => { confirmations.push({ window, options }); return { response: 0 } } },
      ipcMain: { handle: (_channel, callback) => { handler = callback } },
      shell: value.options.shellImpl, env: { GUGO_DESKTOP_BRIDGE_SECRET: secret },
    })
    try {
      assert.equal(confirmations.length, 0, 'setup is not an automatic modal prompt')
      setup.register(() => context)
      const result = await handler({ sender: contents, senderFrame: frame }, value.payload)
      assert.equal(result.canceled, true)
      assert.equal(confirmations.length, 1)
      assert.equal(confirmations[0].window, context.mainWindow)
      assert.equal(confirmations[0].options.defaultId, 0)
      assert.equal(confirmations[0].options.cancelId, 0)
      assert.equal(confirmations[0].options.buttons[0], locale === 'zh-CN' ? '取消' : 'Cancel')
      assert.deepEqual(value.calls.opened, [])
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})
