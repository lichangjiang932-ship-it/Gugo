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

test('upsertHook accepts the extended lifecycle and notification events', () => {
  for (const event of ['pre_compact', 'session_start', 'session_end', 'subagent_stop', 'notification']) {
    const hook = upsertHook({
      userId: 'u_hooks_events',
      event,
      toolPattern: '*',
      kind: 'http',
      url: 'https://example.com/hook',
      headers: null,
      enabled: true,
      blocking: false,
      timeoutMs: 5000,
    })
    assert.equal(hook.event, event)
  }
})

test('pre_tool_use hook permissionDecision=allow is forwarded and skips approval', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    upsertHook({
      userId: 'u_hooks_decision',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      kind: 'shell',
      command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ allow: true, permissionDecision: "allow" }))'],
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    const result = await dispatchHooks({
      userId: 'u_hooks_decision',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'x.txt' },
    })
    assert.equal(result.allow, true)
    assert.equal(result.permissionDecision, 'allow')
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('pre_tool_use hook permissionDecision=deny is surfaced as a rejection', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    upsertHook({
      userId: 'u_hooks_deny',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      kind: 'shell',
      command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ allow: true, permissionDecision: "deny", reason: "blocked by policy" }))'],
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    const result = await dispatchHooks({
      userId: 'u_hooks_deny',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'x.txt' },
    })
    assert.equal(result.allow, false)
    assert.equal(result.permissionDecision, 'deny')
    assert.match(result.reason, /blocked by policy/)
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})
