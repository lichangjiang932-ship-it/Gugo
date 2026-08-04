import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-hooks-service-tests', String(process.pid))

const {
  _hooksInternals,
  dispatchHooks,
  testHook,
  upsertHook,
} = await import('../server/services/hooksService.js')
const { closeDb } = await import('../server/db.js')

test.after(() => {
  closeDb()
})

test('runHttp blocks SSRF target (127.0.0.1)', async () => {
  const hook = upsertHook({
    userId: 'u_hooks_ssrf',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'http://127.0.0.1:9999/x',
    headers: null,
    enabled: true,
    blocking: true,
    timeoutMs: 500,
  })

  const outcome = await testHook({ userId: 'u_hooks_ssrf', id: hook.id })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error || '', /ssrf|blocked|private|内网|loopback/i)
})

test('runHttp requires https for outbound hook URLs', async () => {
  const hook = upsertHook({
    userId: 'u_hooks_https',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'http://1.1.1.1/hook',
    headers: null,
    enabled: true,
    blocking: true,
    timeoutMs: 500,
  })

  const outcome = await testHook({ userId: 'u_hooks_https', id: hook.id })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, 'http_required_https')
})

test('dispatchHooks does not throw when a blocking http hook is SSRF-blocked', async () => {
  upsertHook({
    userId: 'u_hooks_dispatch',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'http://127.0.0.1:9999/x',
    headers: null,
    enabled: true,
    blocking: true,
    timeoutMs: 500,
  })

  const result = await dispatchHooks({
    userId: 'u_hooks_dispatch',
    event: 'pre_tool_use',
    tool: 'demo',
    args: { ok: true },
  })

  assert.equal(result.allow, true)
})

test('shell hooks require an explicit executable allowlist', () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    assert.doesNotThrow(() => _hooksInternals.assertShellCommandAllowed([process.execPath, '-e', '']))
    assert.throws(
      () => _hooksInternals.assertShellCommandAllowed(['definitely-not-allowed', '--version']),
      /not allowed/,
    )
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})
