import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 防御性:即使本文件是纯函数测试,也绝不让任何模块写到真实 server-data/
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'yma-approval-policy-'))
process.env.APP_DATA_DIR = TMP_DIR

const {
  classifyToolRisk,
  resolveApprovalMode,
  resolveApprovalTimeoutMs,
  isOutsideWorkspacePath,
  APPROVAL_REQUIRED_TOOLS,
  NEVER_APPROVE_TOOLS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  buildRememberedGrant,
  isSafeCommandPrefix,
  matchesRememberedGrant,
} = await import('../server/utils/approvalPolicy.js')
const { CONNECTOR_WRITE_TOOL_NAMES } = await import('../shared/connectorWriteTools.js')

const JOB = { origin: 'job', mode: 'unattended' }

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true })
})

// ─────────────────────────── NEVER_APPROVE_TOOLS ───────────────────────────

test('every NEVER_APPROVE_TOOLS entry is never gated (regression guard)', () => {
  for (const name of NEVER_APPROVE_TOOLS) {
    for (const mode of ['unattended', 'all']) {
      for (const origin of ['job', 'subagent', 'chat']) {
        const out = classifyToolRisk(name, { path: '/etc/passwd', command: 'rm -rf /' }, { origin, mode })
        assert.deepEqual(
          out,
          { needsApproval: false, risk: 'low', reason: null },
          `${name} wrongly gated (mode=${mode}, origin=${origin})`,
        )
      }
    }
  }
})

test('server-executable artifact generators are whitelisted by name', () => {
  const artifactTools = [
    'create_pptx',
    'create_docx',
    'create_xlsx',
  ]
  for (const name of artifactTools) {
    assert.ok(NEVER_APPROVE_TOOLS.includes(name), `${name} missing from NEVER_APPROVE_TOOLS`)
    // 名字启发式(create_/run_)本会判成写操作 —— 白名单必须优先
    const out = classifyToolRisk(name, {}, JOB)
    assert.equal(out.needsApproval, false, `${name} regressed to needing approval`)
    assert.equal(out.risk, 'low')
    assert.equal(out.reason, null)
  }
})

test('NEVER_APPROVE_TOOLS and APPROVAL_REQUIRED_TOOLS do not overlap', () => {
  for (const name of NEVER_APPROVE_TOOLS) {
    assert.ok(!(name in APPROVAL_REQUIRED_TOOLS), `${name} in both lists`)
  }
})

// ─────────────────────────────── bash_exec ────────────────────────────────

test('bash_exec: benign command needs approval at high risk mentioning shell', () => {
  const out = classifyToolRisk('bash_exec', { command: 'ls -la' }, JOB)
  assert.equal(out.needsApproval, true)
  assert.equal(out.risk, 'high')
  assert.equal(out.reason, '执行 shell 命令')
})

test('bash_exec: dangerous command stays high with a bashGuard reason', () => {
  const out = classifyToolRisk('bash_exec', { command: 'rm -rf /' }, JOB)
  assert.equal(out.needsApproval, true)
  assert.equal(out.risk, 'high')
  assert.ok(typeof out.reason === 'string' && out.reason.length > 0)
  assert.ok(out.reason.startsWith('危险命令:'), `unexpected reason: ${out.reason}`)
  assert.notEqual(out.reason, '执行 shell 命令')
})

test('bash_exec: missing / non-string command does not throw', () => {
  for (const args of [{}, { command: null }, { command: 123 }]) {
    const out = classifyToolRisk('bash_exec', args, JOB)
    assert.equal(out.needsApproval, true)
    assert.equal(out.risk, 'high')
  }
})

test('bash_exec can never create or consume a standing rule', () => {
  assert.throws(
    () => buildRememberedGrant('bash_exec', { command: 'git status' }),
    /Shell tools cannot be remembered/,
  )
  const legacyGrant = { toolName: 'bash_exec', commandPrefix: 'git status' }
  assert.equal(matchesRememberedGrant('bash_exec', { command: 'git status' }, [legacyGrant]), false)
})

test('bash_exec remembered grants reject shell operators and ignore legacy tool-wide grants', () => {
  for (const command of [
    'git status; rm -rf /',
    'git status && rm -rf /',
    'git status | tee out',
    'git status > out',
    'git status < in',
    'git `status`',
    'git $(status)',
    'git status\nrm -rf /',
  ]) {
    assert.equal(isSafeCommandPrefix(command), false, command)
    assert.throws(() => buildRememberedGrant('bash_exec', { command }))
  }
  const verdict = classifyToolRisk('bash_exec', { command: 'git status' }, {
    ...JOB,
    rememberedTools: ['bash_exec'],
  })
  assert.equal(verdict.needsApproval, true)
})

test('bash_exec legacy remembered prefixes never bypass approval', () => {
  const rememberedGrants = [{ toolName: 'bash_exec', commandPrefix: 'git status' }]
  assert.equal(classifyToolRisk('bash_exec', { command: 'git status --short' }, {
    ...JOB,
    rememberedGrants,
  }).needsApproval, true)
  assert.equal(classifyToolRisk('bash_exec', { command: 'git status && rm -rf /' }, {
    ...JOB,
    rememberedGrants,
  }).needsApproval, true)
})

// ──────────────────────── write_file / edit_file ──────────────────────────

test('write_file / edit_file: in-workspace relative path is medium', () => {
  for (const name of ['write_file', 'edit_file']) {
    for (const p of ['src/index.js', './a.txt', 'a.txt', 'deep/nested/dir/file.md']) {
      const out = classifyToolRisk(name, { path: p }, JOB)
      assert.equal(out.needsApproval, true, `${name} ${p}`)
      assert.equal(out.risk, 'medium', `${name} ${p}`)
      assert.equal(out.reason, '修改文件')
    }
  }
})

test('write_file / edit_file: outside-workspace paths escalate to high', () => {
  const outside = ['/etc/passwd', 'C:\\Windows\\x', '../escape', '~/x', '\\\\server\\share']
  for (const name of ['write_file', 'edit_file']) {
    for (const p of outside) {
      const out = classifyToolRisk(name, { path: p }, JOB)
      assert.equal(out.needsApproval, true, `${name} ${p}`)
      assert.equal(out.risk, 'high', `${name} ${p} should be high`)
      assert.equal(out.reason, '写入工作区之外的路径')
    }
  }
})

test('isOutsideWorkspacePath classifies paths directly', () => {
  for (const p of ['/etc/passwd', 'C:\\Windows\\x', 'c:/tmp/x', '../escape', 'a/../../b', '~/x', '~', '\\\\server\\share']) {
    assert.equal(isOutsideWorkspacePath(p), true, `${p} should be outside`)
  }
  for (const p of ['src/index.js', './a.txt', 'a.txt', 'dir/sub/file', '', '   ', null, undefined, 42, {}]) {
    assert.equal(isOutsideWorkspacePath(p), false, `${JSON.stringify(p)} should be inside`)
  }
})

// ─────────────────────────────── apply_patch ───────────────────────────────

test('apply_patch: dry_run skips approval entirely', () => {
  const out = classifyToolRisk('apply_patch', { dry_run: true, changes: [1, 2, 3, 4, 5, 6, 7] }, JOB)
  assert.deepEqual(out, { needsApproval: false, risk: 'low', reason: null })
})

test('patch_file uses local-write approval with a dry-run exception', () => {
  assert.deepEqual(
    classifyToolRisk('patch_file', { path: 'src/app.js', dry_run: true }, JOB),
    { needsApproval: false, risk: 'low', reason: null },
  )
  const out = classifyToolRisk('patch_file', { path: 'src/app.js' }, JOB)
  assert.equal(out.needsApproval, true)
  assert.equal(out.risk, 'medium')
})

test('apply_patch: large change set (6 files) escalates to high', () => {
  const changes = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.js` }))
  const out = classifyToolRisk('apply_patch', { changes }, JOB)
  assert.equal(out.needsApproval, true)
  assert.equal(out.risk, 'high')
  assert.equal(out.reason, '原子修改 6 个文件')
})

test('apply_patch: small change set stays medium', () => {
  for (const n of [1, 2, 5]) {
    const changes = Array.from({ length: n }, (_, i) => ({ path: `f${i}.js` }))
    const out = classifyToolRisk('apply_patch', { changes }, JOB)
    assert.equal(out.needsApproval, true)
    assert.equal(out.risk, 'medium', `${n} changes should stay medium`)
    assert.equal(out.reason, `原子修改 ${n} 个文件`)
  }
})

test('apply_patch: missing / malformed changes stays medium with generic reason', () => {
  for (const args of [{}, { changes: null }, { changes: 'nope' }, { changes: [], dry_run: false }]) {
    const out = classifyToolRisk('apply_patch', args, JOB)
    assert.equal(out.needsApproval, true)
    assert.equal(out.risk, 'medium')
    assert.equal(out.reason, '原子修改文件')
  }
})

// ──────────────────────────────── fetch_url ────────────────────────────────

test('fetch_url: safe HTTP methods and missing method need no approval', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options', undefined, null, '']) {
    const out = classifyToolRisk('fetch_url', { url: 'https://example.com', method }, JOB)
    assert.deepEqual(out, { needsApproval: false, risk: 'low', reason: null }, `method=${method}`)
  }
  assert.deepEqual(
    classifyToolRisk('fetch_url', { url: 'https://example.com' }, JOB),
    { needsApproval: false, risk: 'low', reason: null },
  )
})

test('fetch_url: mutating HTTP methods need approval at medium', () => {
  for (const method of ['POST', 'DELETE', 'PUT', 'patch']) {
    const out = classifyToolRisk('fetch_url', { url: 'https://example.com', method }, JOB)
    assert.equal(out.needsApproval, true, `method=${method}`)
    assert.equal(out.risk, 'medium', `method=${method}`)
    assert.equal(out.reason, `对外发起 ${method.toUpperCase()} 请求`)
  }
})

// ─────────────────────── unknown / dynamic tool names ──────────────────────

test('unknown tools with write intent are gated at medium', () => {
  for (const name of ['slack_send_message', 'github_create_issue', 'calendar_update_event', 'delete_thing']) {
    const out = classifyToolRisk(name, {}, JOB)
    assert.equal(out.needsApproval, true, `${name} should be gated`)
    assert.equal(out.risk, 'medium', `${name}`)
    assert.equal(out.reason, '外部工具的写操作')
  }
})

test('unknown read-ish tools are not gated', () => {
  for (const name of ['foo_list', 'get_bar', 'something_search', 'linear_issue_details', 'jira_query']) {
    const out = classifyToolRisk(name, {}, JOB)
    assert.deepEqual(out, { needsApproval: false, risk: 'low', reason: null }, `${name} should pass`)
  }
})

test('connector writes cannot be bypassed by remembered grants', () => {
  const grant = buildRememberedGrant('slack_send_message', { channelId: 'C-ops', text: 'first' })
  assert.deepEqual(grant, { toolName: 'slack_send_message', commandPrefix: 'target:channelId=C-ops' })
  assert.equal(classifyToolRisk('slack_send_message', { channelId: 'C-ops', text: 'later' }, {
    ...JOB, rememberedGrants: [grant],
  }).needsApproval, true)
  assert.equal(classifyToolRisk('slack_send_message', { channelId: 'C-finance', text: 'later' }, {
    ...JOB, rememberedGrants: [grant],
  }).needsApproval, true)
})

test('legacy tool-wide grants no longer bypass target-scoped approval', () => {
  const verdict = classifyToolRisk('slack_send_message', { channelId: 'C-ops', text: 'hello' }, {
    ...JOB,
    rememberedTools: ['slack_send_message'],
    rememberedGrants: [{ toolName: 'slack_send_message', commandPrefix: '' }],
  })
  assert.equal(verdict.needsApproval, true)
})

test('connector writes ignore target-scoped remembered grants', () => {
  const args = { channelId: 'C-ops', text: 'hello' }
  const grant = buildRememberedGrant('slack_send_message', args)
  const verdict = classifyToolRisk('slack_send_message', args, {
    ...JOB,
    rememberedGrants: [grant],
  })
  assert.equal(verdict.needsApproval, true)
  assert.equal(verdict.authorization, undefined)
})

test('tools without a semantic target use an exact non-sensitive argument fingerprint', () => {
  const grant = buildRememberedGrant('publish_report', { payload: { title: 'A', body: 'secret' } })
  assert.match(grant.commandPrefix, /^args:[a-f0-9]{24}$/)
  assert.equal(matchesRememberedGrant('publish_report', { payload: { body: 'secret', title: 'A' } }, [grant]), true)
  assert.equal(matchesRememberedGrant('publish_report', { payload: { title: 'B', body: 'secret' } }, [grant]), false)
  assert.doesNotMatch(grant.commandPrefix, /secret/)
})

test('explicit dynamic-tool metadata overrides unsafe name guessing', () => {
  assert.deepEqual(classifyToolRisk('read_user_data', {}, {
    ...JOB, metadata: { riskClass: 'external', requiresApproval: true },
  }), { needsApproval: true, risk: 'medium', reason: '调用可能产生副作用的外部工具' })
  assert.deepEqual(classifyToolRisk('odd_remote_name', {}, {
    ...JOB, metadata: { riskClass: 'read', requiresApproval: false },
  }), { needsApproval: false, risk: 'low', reason: null })
})

test('git mutation tools always require high-risk approval', () => {
  for (const name of ['git_commit', 'git_push', 'git_rollback', 'git_write']) {
    const result = classifyToolRisk(name, {}, { mode: 'unattended', origin: 'job' })
    assert.equal(result.needsApproval, true, `${name} should require approval`)
    assert.equal(result.risk, 'high', `${name} should be high risk`)
  }
})

// ───────────────────────────── mode / origin ───────────────────────────────

test("mode 'off' closes the queue and fails closed for risky calls", () => {
  for (const origin of ['job', 'subagent', 'chat']) {
    for (const name of ['bash_exec', 'write_file', 'apply_patch', 'slack_send_message']) {
      const out = classifyToolRisk(name, { command: 'rm -rf /', path: '/etc/passwd' }, {
        origin,
        mode: 'off',
        permissionMode: 'normal',
      })
      assert.equal(out.needsApproval, false, `${name}/${origin}`)
      assert.equal(out.denied, true, `${name}/${origin}`)
      assert.match(out.reason, /审批队列已关闭/, `${name}/${origin}`)
    }
  }
})

test('run_command inherits shell-grade approval and cannot use standing grants', () => {
  const out = classifyToolRisk('run_command', { command: 'python -V' }, JOB)
  assert.equal(out.needsApproval, true)
  assert.equal(out.risk, 'high')
  assert.throws(() => buildRememberedGrant('run_command', { command: 'python -V' }), /Shell tools/)
})

test('run_project_check follows the four permission modes and cannot use standing grants', () => {
  const args = { check: 'test' }
  for (const permissionMode of ['normal', 'acceptEdits']) {
    const verdict = classifyToolRisk('run_project_check', args, {
      origin: 'job',
      mode: 'unattended',
      permissionMode,
      metadata: { riskClass: 'exec', isReadOnly: false },
    })
    assert.equal(verdict.needsApproval, true, permissionMode)
    assert.equal(verdict.denied, undefined, permissionMode)
    assert.equal(verdict.risk, 'high', permissionMode)
  }

  const plan = classifyToolRisk('run_project_check', args, {
    origin: 'job',
    mode: 'unattended',
    permissionMode: 'plan',
    metadata: { riskClass: 'exec', isReadOnly: false },
  })
  assert.equal(plan.needsApproval, false)
  assert.equal(plan.denied, true)
  assert.equal(plan.risk, 'high')
  assert.match(plan.reason, /计划模式/)

  const bypass = classifyToolRisk('run_project_check', args, {
    origin: 'job',
    mode: 'unattended',
    permissionMode: 'bypass',
    metadata: { riskClass: 'exec', isReadOnly: false },
  })
  assert.equal(bypass.needsApproval, false)
  assert.equal(bypass.denied, undefined)
  assert.equal(bypass.risk, 'high')

  assert.throws(
    () => buildRememberedGrant('run_project_check', args),
    /Shell tools cannot be remembered/,
  )
  assert.equal(matchesRememberedGrant('run_project_check', args, [{
    toolName: 'run_project_check',
    commandPrefix: 'args:legacy',
  }]), false)
})

test('plan mode keeps tools loaded but executes only local read operations', () => {
  for (const name of [
    'read_file', 'list_directory', 'grep_code', 'find_symbol', 'list_imports',
    'git_status', 'git_diff', 'image_info', 'pdf_text', 'archive_list', 'process_list',
  ]) {
    assert.deepEqual(
      classifyToolRisk(name, {}, { ...JOB, permissionMode: 'plan' }),
      { needsApproval: false, risk: 'low', reason: null },
      name,
    )
  }

  for (const name of [
    'write_file', 'apply_patch', 'bash_exec', 'run_project_check', 'create_docx',
    'web_search', 'fetch_url', 'browser_snapshot', 'connected_app_list', 'jira_query',
  ]) {
    const verdict = classifyToolRisk(name, {}, {
      ...JOB,
      permissionMode: 'plan',
      metadata: { riskClass: 'read', requiresApproval: false, isReadOnly: true, origin: 'mcp' },
    })
    assert.equal(verdict.needsApproval, false, name)
    assert.equal(verdict.denied, true, name)
    assert.match(verdict.reason, /工具仍已加载/, name)
    assert.match(verdict.reason, /自动接受编辑模式或正常模式/, name)
  }
})

test('plan mode does not grant builtin read privileges to a dynamic same-name tool', () => {
  for (const origin of ['plugin', 'mcp']) {
    const verdict = classifyToolRisk('read_file', { path: 'README.md' }, {
      ...JOB,
      permissionMode: 'plan',
      metadata: {
        origin,
        riskClass: 'read',
        requiresApproval: false,
        isReadOnly: true,
      },
    })
    assert.equal(verdict.needsApproval, false, origin)
    assert.equal(verdict.denied, true, origin)
    assert.match(verdict.reason, /计划模式/, origin)
  }
})

test('run_command approval names requested host credentials without exposing values', () => {
  const out = classifyToolRisk('run_command', {
    command: 'npm publish',
    env_keys: ['NPM_TOKEN', 'DATABASE_URL'],
  }, JOB)
  assert.equal(out.needsApproval, true)
  assert.equal(out.risk, 'high')
  assert.match(out.reason, /NPM_TOKEN/u)
  assert.match(out.reason, /DATABASE_URL/u)
  assert.doesNotMatch(out.reason, /secret|password=/iu)
})

test('browser navigation and interaction actions require approval', () => {
  for (const name of ['browser_open_url', 'browser_navigate']) {
    const out = classifyToolRisk(name, { url: 'https://example.com' }, JOB)
    assert.equal(out.needsApproval, true, `${name} should be gated`)
    assert.equal(out.risk, 'low', `${name} risk`)
  }
  for (const name of ['browser_click', 'browser_type', 'browser_select', 'browser_press']) {
    const out = classifyToolRisk(name, { target: 'e1' }, JOB)
    assert.equal(out.needsApproval, true, `${name} should be gated`)
    assert.equal(out.risk, 'medium', `${name} risk`)
  }
})

test('run_test and docker_exec inherit shell-grade approval and command checks', () => {
  for (const name of ['run_test', 'docker_exec']) {
    const normal = classifyToolRisk(name, { command: 'python -m pytest' }, JOB)
    assert.equal(normal.needsApproval, true, name)
    assert.equal(normal.risk, 'high', name)
    assert.match(normal.reason, /shell|代码|命令/i, name)

    const dangerous = classifyToolRisk(name, { command: 'rm -rf /' }, JOB)
    assert.equal(dangerous.needsApproval, true, name)
    assert.equal(dangerous.risk, 'high', name)
    assert.match(dangerous.reason, /危险命令/i, name)
  }
})

test('file_download is a medium local write and escalates outside the workspace', () => {
  const local = classifyToolRisk('file_download', { url: 'https://example.com/a', path: 'downloads/a' }, JOB)
  assert.equal(local.needsApproval, true)
  assert.equal(local.risk, 'medium')

  const external = classifyToolRisk('file_download', { url: 'https://example.com/a', path: '/tmp/a' }, JOB)
  assert.equal(external.needsApproval, true)
  assert.equal(external.risk, 'high')
})

test('acceptEdits still requires approval before downloading a file', () => {
  const verdict = classifyToolRisk(
    'file_download',
    { url: 'https://example.com/a', path: 'downloads/a' },
    { origin: 'job', mode: 'unattended', permissionMode: 'acceptEdits' },
  )

  assert.equal(verdict.needsApproval, true)
  assert.equal(verdict.denied, undefined)
  assert.equal(verdict.risk, 'medium')
})

test("mode 'unattended' never weakens the user's normal permission mode", () => {
  for (const origin of ['chat', 'job', 'subagent']) {
    const out = classifyToolRisk('bash_exec', { command: 'ls' }, {
      origin,
      mode: 'unattended',
      permissionMode: 'normal',
    })
    assert.equal(out.needsApproval, true, `origin=${origin} should be gated`)
    assert.equal(out.risk, 'high')
  }
})

test('permission-mode matrix keeps user policy stronger than every deployment mode', () => {
  const riskyArgs = { command: 'rm -rf build' }
  for (const mode of ['off', 'unattended', 'all']) {
    const plan = classifyToolRisk('bash_exec', riskyArgs, { mode, permissionMode: 'plan' })
    assert.equal(plan.denied, true, `plan/${mode}`)
    assert.equal(plan.needsApproval, false, `plan/${mode}`)

    const normal = classifyToolRisk('bash_exec', riskyArgs, { mode, permissionMode: 'normal' })
    if (mode === 'off') {
      assert.equal(normal.denied, true, `normal/${mode}`)
      assert.equal(normal.needsApproval, false, `normal/${mode}`)
    } else {
      assert.equal(normal.denied, undefined, `normal/${mode}`)
      assert.equal(normal.needsApproval, true, `normal/${mode}`)
    }

    const bypass = classifyToolRisk('bash_exec', riskyArgs, { mode, permissionMode: 'bypass' })
    assert.equal(bypass.denied, undefined, `bypass/${mode}`)
    assert.equal(bypass.needsApproval, false, `bypass/${mode}`)
    assert.equal(bypass.risk, 'high', `bypass/${mode}`)
  }
})

test('plan cannot be bypassed by read metadata on a known mutating tool', () => {
  for (const mode of ['off', 'unattended', 'all']) {
    const verdict = classifyToolRisk('write_file', { path: 'output.txt', content: 'x' }, {
      mode,
      permissionMode: 'plan',
      metadata: { riskClass: 'read', requiresApproval: false },
    })
    assert.equal(verdict.denied, true, mode)
    assert.equal(verdict.needsApproval, false, mode)
  }
})

test('plan rejects write-tool previews and network reads while keeping schemas loaded', () => {
  for (const mode of ['off', 'unattended', 'all']) {
    for (const [name, args] of [
      ['apply_patch', { dry_run: true }],
      ['fetch_url', { method: 'GET' }],
    ]) {
      const verdict = classifyToolRisk(name, args, { mode, permissionMode: 'plan' })
      assert.equal(verdict.needsApproval, false, `${name}/${mode}`)
      assert.equal(verdict.denied, true, `${name}/${mode}`)
      assert.match(verdict.reason, /工具仍已加载/, `${name}/${mode}`)
    }
  }
})

test('QQ Mail send always requires a per-call decision in unattended chat', () => {
  const args = { to: 'recipient@example.com', subject: 'Status', text: 'Done' }
  const grant = buildRememberedGrant('qq_mail_send', args)
  const cases = [
    { origin: 'chat', mode: 'unattended' },
    { origin: 'chat', mode: 'unattended', metadata: { riskClass: 'read', requiresApproval: false } },
    { origin: 'chat', mode: 'unattended', rememberedGrants: [grant] },
  ]
  for (const options of cases) {
    const verdict = classifyToolRisk('qq_mail_send', args, options)
    assert.equal(verdict.needsApproval, true)
    assert.equal(verdict.risk, 'medium')
    assert.equal(verdict.reason, '发送外部邮件')
  }
})

test('every connector write requires approval in unattended chat', () => {
  assert.equal(CONNECTOR_WRITE_TOOL_NAMES.length, 42)
  for (const name of CONNECTOR_WRITE_TOOL_NAMES) {
    const verdict = classifyToolRisk(name, {}, { origin: 'chat', mode: 'unattended' })
    assert.equal(verdict.needsApproval, true, `${name} bypassed approval`)
    assert.equal(verdict.risk, 'medium', name)
  }
})

test("mode 'all' gates chat origin too", () => {
  for (const origin of ['chat', 'job', 'subagent']) {
    const out = classifyToolRisk('bash_exec', { command: 'ls' }, { origin, mode: 'all' })
    assert.equal(out.needsApproval, true, `origin=${origin}`)
    assert.equal(out.risk, 'high')
  }
  // 白名单仍然优先于 'all'
  assert.equal(classifyToolRisk('read_file', {}, { origin: 'chat', mode: 'all' }).needsApproval, false)
})

test('origin defaults to job when omitted', () => {
  const out = classifyToolRisk('bash_exec', { command: 'ls' }, { mode: 'unattended' })
  assert.equal(out.needsApproval, true)
})

// ───────────────────────────── env resolution ──────────────────────────────

test('resolveApprovalMode accepts valid values and falls back otherwise', () => {
  for (const raw of ['off', 'unattended', 'all']) {
    assert.equal(resolveApprovalMode({ APPROVAL_MODE: raw }), raw)
    assert.equal(resolveApprovalMode({ APPROVAL_MODE: raw.toUpperCase() }), raw)
    assert.equal(resolveApprovalMode({ APPROVAL_MODE: `  ${raw}  ` }), raw)
  }
  for (const raw of ['bogus', 'ON', '1', 'none', '', '   ', undefined, null, 0]) {
    assert.equal(resolveApprovalMode({ APPROVAL_MODE: raw }), 'unattended', `raw=${raw}`)
  }
  assert.equal(resolveApprovalMode({}), 'unattended')
})

test('resolveApprovalTimeoutMs accepts positive numbers and falls back otherwise', () => {
  assert.equal(resolveApprovalTimeoutMs({ APPROVAL_TIMEOUT_MS: '30000' }), 30_000)
  assert.equal(resolveApprovalTimeoutMs({ APPROVAL_TIMEOUT_MS: 12_345 }), 12_345)
  assert.equal(resolveApprovalTimeoutMs({ APPROVAL_TIMEOUT_MS: '5000.9' }), 5000)
  for (const raw of [0, '0', -1, '-500', 'abc', '', NaN, Infinity, undefined, null]) {
    assert.equal(
      resolveApprovalTimeoutMs({ APPROVAL_TIMEOUT_MS: raw }),
      DEFAULT_APPROVAL_TIMEOUT_MS,
      `raw=${raw}`,
    )
  }
  assert.equal(resolveApprovalTimeoutMs({}), DEFAULT_APPROVAL_TIMEOUT_MS)
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 86_400_000)
})

// ──────────────────────── malformed input robustness ───────────────────────

test('classifyToolRisk tolerates malformed input without throwing', () => {
  const cases = [
    [],
    [null],
    [undefined],
    ['', null],
    ['bash_exec', null],
    ['bash_exec', undefined, undefined],
    // options 显式为 null / 非对象:default 参数不生效,内部必须自己兜住
    ['bash_exec', { command: 'ls' }, null],
    ['bash_exec', { command: 'ls' }, 'not-an-object'],
    [123, 'not-an-object'],
    [{}, []],
    ['write_file', 'string-args', { mode: 'all' }],
  ]
  for (const argv of cases) {
    let out
    assert.doesNotThrow(() => {
      out = classifyToolRisk(...argv)
    }, `threw for ${JSON.stringify(argv)}`)
    assert.equal(typeof out.needsApproval, 'boolean')
    assert.ok(['low', 'medium', 'high'].includes(out.risk))
    assert.ok(out.reason === null || typeof out.reason === 'string')
  }
})

test('非字符串工具名不会抛错(数字/对象/数组)', () => {
  // 这些都归一化成空名 → 走「身份不明」分支拒绝,但绝不能抛
  for (const name of [0, {}, []]) {
    let out
    assert.doesNotThrow(() => {
      out = classifyToolRisk(name, {}, { origin: 'job', mode: 'all' })
    }, `name=${String(name)}`)
    assert.equal(out.needsApproval, false, '不该进审批队列')
    assert.equal(out.denied, true, '身份不明必须拒绝,不能当成安全放行')
  }
})

// ★ 安全回归:空/畸形工具名以前会 fail-open。
// classifyToolRisk 里 `if (!name) return { needsApproval: false }` 意味着
// 一个身份不明的调用直接绕过整个审批门控。子代理那次 wire 形状解析漏了,
// toolName 正好是 undefined —— 门控当时是完全失效的。
// 身份不明 = 无法判定风险 = 必须拒绝,不能当成安全。
test('★ 安全:空/畸形工具名一律拒绝,不得 fail-open', () => {
  for (const bad of ['', '   ', '\t', '\n', null, undefined]) {
    const verdict = classifyToolRisk(bad, { command: 'rm -rf /' }, {
      origin: 'job', mode: 'all', permissionMode: 'normal',
    })
    assert.equal(verdict.denied, true, `工具名 ${JSON.stringify(bad)} 必须被拒绝`)
    assert.equal(verdict.needsApproval, false, '拒绝不是「等审批」,是直接不执行')
    assert.equal(verdict.risk, 'high')
  }
})

test('★ 安全:空工具名在任何权限档位下都不放行', () => {
  // 连 bypass 都不行 —— 用户选的是「信任我认识的工具」,不是「信任不明来源」
  for (const permissionMode of ['normal', 'acceptEdits', 'plan', 'bypass']) {
    const verdict = classifyToolRisk('', { command: 'x' }, { origin: 'job', mode: 'all', permissionMode })
    assert.notEqual(verdict.needsApproval, true, `${permissionMode}: 不该进审批队列`)
    assert.equal(verdict.denied, true, `${permissionMode}: 应直接拒绝`)
  }
})

test('正常工具不受空名检查影响', () => {
  assert.equal(
    classifyToolRisk('bash_exec', { command: 'ls' }, { origin: 'job', mode: 'all' }).needsApproval,
    true,
  )
  assert.equal(
    classifyToolRisk('read_file', { path: 'x' }, { origin: 'job', mode: 'all' }).needsApproval,
    false,
  )
})

test('acceptEdits still confirms destructive PDF text/form operations by argument', () => {
  for (const operation of ['fill_form', 'overlay_text']) {
    const verdict = classifyToolRisk('pdf_transform', { operation }, {
      origin: 'chat',
      mode: 'unattended',
      permissionMode: 'acceptEdits',
    })
    assert.equal(verdict.needsApproval, true, operation)
    assert.equal(verdict.risk, 'medium', operation)
    assert.match(verdict.reason, /PDF|覆盖/)
  }
})

test('acceptEdits allows reversible PDF transforms and local archive edits', () => {
  for (const [name, args] of [
    ['pdf_transform', { operation: 'watermark' }],
    ['pdf_transform', { operation: 'rotate' }],
    ['archive_create', { outputPath: 'bundle.zip' }],
    ['archive_extract', { path: 'bundle.zip', outputDir: 'out' }],
    ['batch_rename', { operations: [] }],
  ]) {
    const verdict = classifyToolRisk(name, args, {
      origin: 'job',
      mode: 'all',
      permissionMode: 'acceptEdits',
    })
    assert.equal(verdict.needsApproval, false, name)
    assert.equal(verdict.denied, undefined, name)
  }
})
