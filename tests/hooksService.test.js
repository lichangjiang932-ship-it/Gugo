import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-hooks-service-tests', String(process.pid))

const {
  _hooksInternals,
  dispatchHooks: dispatchHooksRaw,
  testHook: testHookRaw,
  upsertHook,
} = await import('../server/services/hooksService.js')
const { closeDb, getDb } = await import('../server/db.js')

let hookInvocationSequence = 0
function dispatchHooks(ctx) {
  hookInvocationSequence += 1
  return dispatchHooksRaw({
    hookInvocationId: ctx?.hookInvocationId || `hooks-service-test-${hookInvocationSequence}`,
    ...ctx,
  })
}

function testHook(input) {
  hookInvocationSequence += 1
  return testHookRaw({
    idempotencyKey: input?.idempotencyKey || `hooks-service-test-${hookInvocationSequence}`,
    ...input,
  })
}

function shellJsonHook(outcome) {
  return [process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(outcome))})`]
}

test.after(() => {
  closeDb()
})

test('testHook requires an explicit idempotency key', async () => {
  const hook = upsertHook({
    userId: 'u_hooks_test_idempotency_required',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'https://example.com/hook',
    enabled: true,
    blocking: true,
    timeoutMs: 500,
  })
  await assert.rejects(
    testHookRaw({ userId: 'u_hooks_test_idempotency_required', id: hook.id }),
    (error) => error?.code === 'HOOK_IDEMPOTENCY_KEY_REQUIRED' && error?.statusCode === 400,
  )
})

test('HTTP Hook idempotency headers cannot be overridden by stored headers', () => {
  const headers = _hooksInternals.hookRequestHeaders({
    'idempotency-key': 'attacker-lower',
    'Idempotency-Key': 'attacker-title',
    'content-type': 'text/plain',
    'X-Hook': 'kept',
  }, 'trusted-key')
  assert.deepEqual(headers, {
    'X-Hook': 'kept',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'trusted-key',
  })
})

test('shell Hook payload carries the durable idempotency key and invocation ID', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const hook = upsertHook({
      userId: 'u_hooks_shell_idempotency_payload',
      event: 'pre_tool_use',
      toolPattern: '*',
      kind: 'shell',
      command: [
        process.execPath,
        '-e',
        'const p=JSON.parse(process.argv.at(-1));process.stdout.write(JSON.stringify({allow:true,receivedIdempotencyKey:p.idempotencyKey,receivedInvocationId:p.hookInvocationId}))',
      ],
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    const outcome = await testHook({
      userId: 'u_hooks_shell_idempotency_payload',
      id: hook.id,
      idempotencyKey: 'operator-retry-key',
    })
    const row = getDb().prepare(`
      SELECT idempotency_key FROM side_effect_executions
      WHERE owner_id = ? AND effect_kind = 'hook'
      ORDER BY created_at DESC LIMIT 1
    `).get('u_hooks_shell_idempotency_payload')
    assert.equal(outcome.receivedIdempotencyKey, row.idempotency_key)
    assert.equal(outcome.receivedInvocationId, 'test:operator-retry-key')
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
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

test('dispatchHooks fails closed when a blocking http hook is SSRF-blocked', async () => {
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

  assert.equal(result.allow, false)
  assert.equal(result.code, 'HOOK_EXECUTION_UNTRUSTED')
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
      origin: 'job',
      jobId: 'job-hooks-decision',
      stepId: 'step-hooks-decision',
      sessionId: 'session-hooks-decision',
      requestId: 'request-hooks-decision',
      toolCallId: 'call-hooks-decision',
    })
    assert.equal(result.allow, true)
    assert.equal(result.permissionDecision, 'allow')
    assert.equal(result.hookAuthorizationProvenance?.toolCallId, 'call-hooks-decision')
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

test('argument matchers use recursive object subsets and exact arrays', () => {
  const { matchesArgumentMatcher, normalizeArgumentMatcher } = _hooksInternals
  const matcher = normalizeArgumentMatcher({
    target: { channel: 'ops' },
    labels: ['release', 'urgent'],
  })

  assert.equal(matchesArgumentMatcher(matcher, {
    target: { channel: 'ops', thread: '123' },
    labels: ['release', 'urgent'],
    text: 'ship it',
  }), true)
  assert.equal(matchesArgumentMatcher(matcher, {
    target: { channel: 'general' },
    labels: ['release', 'urgent'],
  }), false)
  assert.equal(matchesArgumentMatcher(matcher, {
    target: { channel: 'ops' },
    labels: ['release', 'urgent', 'extra'],
  }), false)
  assert.throws(() => normalizeArgumentMatcher(['not', 'an', 'object']), /JSON 对象/)
})

test('argument matcher is persisted and permissionDecision=ask only applies on a match', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const hook = upsertHook({
      userId: 'u_hooks_argument_ask',
      event: 'pre_tool_use',
      toolPattern: 'send_*',
      argumentMatcher: { target: { channel: 'ops' } },
      kind: 'shell',
      command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ allow: true, permissionDecision: "ask", reason: "ops review" }))'],
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    assert.deepEqual(hook.argumentMatcher, { target: { channel: 'ops' } })

    const skipped = await dispatchHooks({
      userId: 'u_hooks_argument_ask',
      event: 'pre_tool_use',
      tool: 'send_message',
      args: { target: { channel: 'general' }, text: 'hello' },
    })
    assert.equal(skipped.permissionDecision, undefined)

    const matched = await dispatchHooks({
      userId: 'u_hooks_argument_ask',
      event: 'pre_tool_use',
      tool: 'send_message',
      args: { target: { channel: 'ops', thread: '123' }, text: 'hello' },
    })
    assert.equal(matched.allow, true)
    assert.equal(matched.permissionDecision, 'ask')
    assert.equal(matched.reason, 'ops review')
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('later hooks match against args rewritten by earlier hooks', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const rewrite = upsertHook({
      userId: 'u_hooks_rewritten_matcher',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      kind: 'shell',
      command: shellJsonHook({ allow: true, replacementArgs: { path: 'secret.txt' } }),
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    const review = upsertHook({
      userId: 'u_hooks_rewritten_matcher',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      argumentMatcher: { path: 'secret.txt' },
      kind: 'shell',
      command: shellJsonHook({ allow: true, permissionDecision: 'ask', reason: 'secret review' }),
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(1, rewrite.id)
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(2, review.id)

    const result = await dispatchHooks({
      userId: 'u_hooks_rewritten_matcher',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'public.txt' },
    })

    assert.deepEqual(result.replacementArgs, { path: 'secret.txt' })
    assert.equal(result.permissionDecision, 'ask')
    assert.equal(result.reason, 'secret review')
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('permission decisions use deny over ask over allow regardless of hook order', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const addDecisionHook = (userId, decision, reason) => upsertHook({
      userId,
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      kind: 'shell',
      command: shellJsonHook({ allow: true, permissionDecision: decision, reason }),
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })

    const ask = addDecisionHook('u_hooks_ask_allow_priority', 'ask', 'review first')
    const allowAfterAsk = addDecisionHook('u_hooks_ask_allow_priority', 'allow', 'allow later')
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(1, ask.id)
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(2, allowAfterAsk.id)
    const askResult = await dispatchHooks({
      userId: 'u_hooks_ask_allow_priority',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'x.txt' },
    })
    assert.equal(askResult.permissionDecision, 'ask')
    assert.equal(askResult.reason, 'review first')

    const deny = addDecisionHook('u_hooks_deny_allow_priority', 'deny', 'blocked first')
    const allowAfterDeny = addDecisionHook('u_hooks_deny_allow_priority', 'allow', 'allow later')
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(1, deny.id)
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(2, allowAfterDeny.id)
    const denyResult = await dispatchHooks({
      userId: 'u_hooks_deny_allow_priority',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'x.txt' },
    })
    assert.equal(denyResult.allow, false)
    assert.equal(denyResult.permissionDecision, 'deny')
    assert.equal(denyResult.reason, 'blocked first')
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('invalid persisted argument matcher fails closed', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const hook = upsertHook({
      userId: 'u_hooks_invalid_matcher',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      argumentMatcher: { path: 'secret.txt' },
      kind: 'shell',
      command: shellJsonHook({ allow: true, permissionDecision: 'allow' }),
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    getDb().prepare('UPDATE hooks SET argument_matcher_json = ? WHERE id = ?').run('{"path":', hook.id)

    const result = await dispatchHooks({
      userId: 'u_hooks_invalid_matcher',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'public.txt' },
    })

    assert.equal(result.allow, false)
    assert.match(result.reason, /argumentMatcher/)
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('a later argument rewrite invalidates an earlier Hook allow decision', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const allow = upsertHook({
      userId: 'u_hooks_allow_then_rewrite',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      kind: 'shell',
      command: shellJsonHook({ allow: true, permissionDecision: 'allow' }),
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    const rewrite = upsertHook({
      userId: 'u_hooks_allow_then_rewrite',
      event: 'pre_tool_use',
      toolPattern: 'write_file',
      kind: 'shell',
      command: shellJsonHook({ allow: true, replacementArgs: { path: 'rewritten.txt' } }),
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(1, allow.id)
    getDb().prepare('UPDATE hooks SET created_at = ? WHERE id = ?').run(2, rewrite.id)

    const result = await dispatchHooks({
      userId: 'u_hooks_allow_then_rewrite',
      event: 'pre_tool_use',
      tool: 'write_file',
      args: { path: 'original.txt', content: 'x' },
      origin: 'job',
      jobId: 'job-allow-then-rewrite',
      stepId: 'step-allow-then-rewrite',
      requestId: 'request-allow-then-rewrite',
      toolCallId: 'call-allow-then-rewrite',
    })

    assert.equal(result.allow, true)
    assert.deepEqual(result.replacementArgs, { path: 'rewritten.txt', content: 'x' })
    assert.equal(result.permissionDecision, undefined)
    assert.equal(result.hookAuthorizationProvenance, undefined)
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('blocking shell hooks fail closed on exit failure, timeout, and invalid JSON', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  try {
    const cases = [
      {
        userId: 'u_hooks_shell_exit_failure',
        command: [process.execPath, '-e', 'process.exit(7)'],
        timeoutMs: 5000,
      },
      {
        userId: 'u_hooks_shell_invalid_json',
        command: [process.execPath, '-e', 'process.stdout.write("not-json")'],
        timeoutMs: 5000,
      },
      {
        userId: 'u_hooks_shell_timeout',
        command: [process.execPath, '-e', 'setTimeout(() => {}, 2000)'],
        timeoutMs: 500,
      },
    ]
    for (const item of cases) {
      upsertHook({
        userId: item.userId,
        event: 'pre_tool_use',
        toolPattern: 'write_file',
        kind: 'shell',
        command: item.command,
        enabled: true,
        blocking: true,
        timeoutMs: item.timeoutMs,
      })
      const result = await dispatchHooks({
        userId: item.userId,
        event: 'pre_tool_use',
        tool: 'write_file',
        args: { path: 'blocked.txt', content: 'x' },
      })
      assert.equal(result.allow, false, item.userId)
      assert.equal(result.code, 'HOOK_EXECUTION_UNTRUSTED', item.userId)
    }
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
  }
})

test('shell hooks do not inherit model provider or generic API credentials', async () => {
  const previousEnabled = process.env.HOOKS_SHELL_ENABLED
  const previousAllowed = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  const previousModelKey = process.env.MODEL_API_KEY
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  const previousCustomKey = process.env.HOOK_TEST_VENDOR_API_KEY
  process.env.HOOKS_SHELL_ENABLED = '1'
  process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
  process.env.MODEL_API_KEY = 'model-secret-must-not-leak'
  process.env.OPENAI_API_KEY = 'openai-secret-must-not-leak'
  process.env.HOOK_TEST_VENDOR_API_KEY = 'generic-secret-must-not-leak'
  try {
    const hook = upsertHook({
      userId: 'u_hooks_sanitized_env',
      event: 'pre_tool_use',
      toolPattern: '*',
      kind: 'shell',
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({ allow: true, model: process.env.MODEL_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, generic: process.env.HOOK_TEST_VENDOR_API_KEY ?? null }))',
      ],
      enabled: true,
      blocking: true,
      timeoutMs: 5000,
    })
    const outcome = await testHook({ userId: 'u_hooks_sanitized_env', id: hook.id })
    assert.equal(outcome.allow, true)
    assert.equal(outcome.model, null)
    assert.equal(outcome.openai, null)
    assert.equal(outcome.generic, null)
  } finally {
    if (previousEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
    else process.env.HOOKS_SHELL_ENABLED = previousEnabled
    if (previousAllowed == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
    else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowed
    if (previousModelKey == null) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousModelKey
    if (previousOpenAiKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
    if (previousCustomKey == null) delete process.env.HOOK_TEST_VENDOR_API_KEY
    else process.env.HOOK_TEST_VENDOR_API_KEY = previousCustomKey
  }
})
