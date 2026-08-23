import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  WINDOWS_CONTROL_FRAME_MAGIC,
  WINDOWS_CONTROL_FRAME_VERSION,
  canonicalizeWindowsSessionCwd,
  encodeWindowsControlFrame,
  filterWindowsPersistentEnvironment,
  mergeWindowsEnvironment,
  parseWindowsControlFrame,
  restoreWindowsEphemeralEnvironment,
} from '../server/services/windowsShellSessionProtocol.js'

const MAGIC_BYTES = Buffer.from(WINDOWS_CONTROL_FRAME_MAGIC, 'ascii')
const HEADER_BYTES = MAGIC_BYTES.length + 1 + 4

function controlPayload(overrides = {}) {
  return {
    token: 'request-token',
    exitCode: 7,
    cwd: 'C:\\workspace\\中文',
    env: { Path: 'C:\\bin', UNICODE: '中文🙂' },
    ...overrides,
  }
}

function rawFrame(payloadBytes, {
  magic = MAGIC_BYTES,
  version = WINDOWS_CONTROL_FRAME_VERSION,
  declaredLength = payloadBytes.length,
} = {}) {
  const frame = Buffer.alloc(HEADER_BYTES + payloadBytes.length)
  magic.copy(frame, 0)
  frame[MAGIC_BYTES.length] = version
  frame.writeUInt32BE(declaredLength, MAGIC_BYTES.length + 1)
  payloadBytes.copy(frame, HEADER_BYTES)
  return frame
}

function jsonFrame(payload) {
  return rawFrame(Buffer.from(JSON.stringify(payload), 'utf8'))
}

function errorCode(expectedCode) {
  return (error) => error?.code === expectedCode
}

test('Windows control frame round-trips Unicode payloads exactly', () => {
  const payload = controlPayload()
  const frame = encodeWindowsControlFrame(payload)

  assert.equal(frame.subarray(0, MAGIC_BYTES.length).toString('ascii'), WINDOWS_CONTROL_FRAME_MAGIC)
  assert.equal(frame[MAGIC_BYTES.length], WINDOWS_CONTROL_FRAME_VERSION)
  assert.deepEqual(parseWindowsControlFrame(frame, {
    expectedToken: payload.token,
    expectedExitCode: payload.exitCode,
  }), payload)
})

test('Windows control frame rejects a wrong request token', () => {
  const frame = encodeWindowsControlFrame(controlPayload())

  assert.throws(
    () => parseWindowsControlFrame(frame, { expectedToken: 'another-request' }),
    errorCode('SHELL_CONTROL_TOKEN_MISMATCH'),
  )
})

test('Windows control frame rejects a child/frame exit-code mismatch', () => {
  const frame = encodeWindowsControlFrame(controlPayload())

  assert.throws(
    () => parseWindowsControlFrame(frame, { expectedExitCode: 8 }),
    errorCode('SHELL_CONTROL_EXIT_CODE_MISMATCH'),
  )
})

test('Windows control frame distinguishes missing, truncated header, and truncated payload', () => {
  const frame = encodeWindowsControlFrame(controlPayload())

  assert.throws(
    () => parseWindowsControlFrame(Buffer.alloc(0)),
    errorCode('SHELL_CONTROL_FRAME_MISSING'),
  )
  assert.throws(
    () => parseWindowsControlFrame(frame.subarray(0, HEADER_BYTES - 1)),
    errorCode('SHELL_CONTROL_FRAME_TRUNCATED'),
  )
  assert.throws(
    () => parseWindowsControlFrame(frame.subarray(0, frame.length - 1)),
    errorCode('SHELL_CONTROL_FRAME_TRUNCATED'),
  )
})

test('Windows control frame rejects all trailing bytes', () => {
  const frame = Buffer.concat([
    encodeWindowsControlFrame(controlPayload()),
    Buffer.from('untrusted-tail'),
  ])

  assert.throws(
    () => parseWindowsControlFrame(frame),
    errorCode('SHELL_CONTROL_FRAME_TRAILING_DATA'),
  )
})

test('Windows control frame rejects invalid magic and unsupported versions', () => {
  const invalidMagic = encodeWindowsControlFrame(controlPayload())
  invalidMagic[0] ^= 0xff
  const invalidVersion = encodeWindowsControlFrame(controlPayload())
  invalidVersion[MAGIC_BYTES.length] = WINDOWS_CONTROL_FRAME_VERSION + 1

  assert.throws(
    () => parseWindowsControlFrame(invalidMagic),
    errorCode('SHELL_CONTROL_FRAME_MAGIC_INVALID'),
  )
  assert.throws(
    () => parseWindowsControlFrame(invalidVersion),
    errorCode('SHELL_CONTROL_FRAME_VERSION_UNSUPPORTED'),
  )
})

test('Windows control frame rejects invalid UTF-8 and invalid JSON separately', () => {
  const invalidUtf8 = rawFrame(Buffer.from([0xc3, 0x28]))
  const invalidJson = rawFrame(Buffer.from('{"token":', 'utf8'))

  assert.throws(
    () => parseWindowsControlFrame(invalidUtf8),
    errorCode('SHELL_CONTROL_FRAME_UTF8_INVALID'),
  )
  assert.throws(
    () => parseWindowsControlFrame(invalidJson),
    errorCode('SHELL_CONTROL_FRAME_JSON_INVALID'),
  )
})

test('Windows control frame rejects malformed environment maps', () => {
  const invalidEnvironments = [
    null,
    [],
    { '': 'empty-key' },
    { 'BAD\0KEY': 'value' },
    { VALID_KEY: 42 },
    { VALID_KEY: 'bad\0value' },
  ]

  for (const env of invalidEnvironments) {
    assert.throws(
      () => parseWindowsControlFrame(jsonFrame(controlPayload({ env }))),
      errorCode('SHELL_CONTROL_PAYLOAD_INVALID'),
      `env should be rejected: ${JSON.stringify(env)}`,
    )
  }
})

test('Windows control frame enforces the payload limit on encode and parse', () => {
  const payload = controlPayload()
  const frame = encodeWindowsControlFrame(payload)
  const payloadBytes = frame.length - HEADER_BYTES

  assert.deepEqual(
    parseWindowsControlFrame(frame, { maxPayloadBytes: payloadBytes }),
    payload,
  )
  assert.equal(
    encodeWindowsControlFrame(payload, { maxPayloadBytes: payloadBytes }).length,
    frame.length,
  )
  assert.throws(
    () => encodeWindowsControlFrame(payload, { maxPayloadBytes: payloadBytes - 1 }),
    errorCode('SHELL_CONTROL_FRAME_TOO_LARGE'),
  )
  assert.throws(
    () => parseWindowsControlFrame(frame, { maxPayloadBytes: payloadBytes - 1 }),
    errorCode('SHELL_CONTROL_FRAME_TOO_LARGE'),
  )
})

test('Windows environment merge is case-insensitive and supports deletion overlays', () => {
  const merged = mergeWindowsEnvironment(
    { Path: 'base-path', KEEP: 'kept', Remove: 'old', Duplicate: 'first', DUPLICATE: 'last' },
    new Map([
      ['PATH', 'overlay-path'],
      ['remove', null],
      ['Numeric', 42],
    ]),
  )

  assert.deepEqual(merged, {
    KEEP: 'kept',
    DUPLICATE: 'last',
    PATH: 'overlay-path',
    Numeric: '42',
  })
  assert.equal(Object.keys(merged).filter((key) => key.toLowerCase() === 'path').length, 1)
})

test('Windows ephemeral environment restoration uses pre-request casing and removes new keys', () => {
  const restored = restoreWindowsEphemeralEnvironment(
    {
      Path: 'command-mutated',
      TEMP: 'request-value',
      ONLY_REQUEST: 'request-only',
      KEEP: 'reported',
      AddedByCommand: 'persistent',
      ERRORLEVEL: '999',
      __gugo_request_token: 'internal',
    },
    { PATH: 'before-path', temp: 'before-temp', KEEP: 'before-keep' },
    { path: 'request-path', TeMp: 'request-temp', only_request: 'request-only' },
  )

  assert.deepEqual(restored, {
    KEEP: 'reported',
    AddedByCommand: 'persistent',
    PATH: 'before-path',
    temp: 'before-temp',
  })
})

test('Windows persistent environment filter removes pseudo, hidden, and protocol variables', () => {
  const filtered = filterWindowsPersistentEnvironment({
    Path: 'first',
    PATH: 'last',
    ERRORLEVEL: '7',
    cd: 'C:\\forged',
    CmdCmdLine: 'cmd.exe',
    CMDEXTVERSION: '2',
    Electron_Run_As_Node: '1',
    '=C:': 'C:\\hidden-drive-cwd',
    __GUGO_TOKEN: 'secret',
    __gugo_reporter_status: 'internal',
    GUGO_PUBLIC_SETTING: 'allowed',
    NORMAL: 'kept',
  })

  assert.deepEqual(filtered, {
    PATH: 'last',
    GUGO_PUBLIC_SETTING: 'allowed',
    NORMAL: 'kept',
  })
})

test('Windows session cwd canonicalization accepts real directories and rejects invalid targets', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-win-cwd-protocol-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  const root = path.join(fixture, 'root')
  const inside = path.join(root, 'inside')
  const outside = path.join(fixture, 'outside')
  const file = path.join(root, 'file.txt')
  fs.mkdirSync(inside, { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(file, 'not a directory', 'utf8')

  assert.equal(canonicalizeWindowsSessionCwd(root, inside), fs.realpathSync(inside))
  assert.throws(
    () => canonicalizeWindowsSessionCwd(root, path.join(root, 'missing')),
    errorCode('SHELL_CWD_INVALID'),
  )
  assert.throws(
    () => canonicalizeWindowsSessionCwd(root, file),
    errorCode('SHELL_CWD_INVALID'),
  )
  assert.throws(
    () => canonicalizeWindowsSessionCwd(root, outside),
    errorCode('SHELL_CWD_BOUNDARY_VIOLATION'),
  )
})

test('Windows session cwd canonicalization resolves junctions or symlinks before boundary checks', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-win-cwd-link-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  const root = path.join(fixture, 'root')
  const outside = path.join(fixture, 'outside')
  const escapeLink = path.join(root, 'escape-link')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)

  try {
    fs.symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`current platform cannot create a directory link: ${error.code}`)
      return
    }
    throw error
  }

  assert.throws(
    () => canonicalizeWindowsSessionCwd(root, escapeLink),
    errorCode('SHELL_CWD_BOUNDARY_VIOLATION'),
  )
})
