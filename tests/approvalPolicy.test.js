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
} = await import('../server/utils/approvalPolicy.js')

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

test('create_* artifact tools and run_project_check are whitelisted by name', () => {
  const artifactTools = [
    'create_pptx',
    'create_docx',
    'create_xlsx',
    'create_react_component',
    'create_mermaid',
    'create_chart',
    'create_svg',
    'create_html_app',
    'run_project_check',
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

// ───────────────────────────── mode / origin ───────────────────────────────

test("mode 'off' lets everything through", () => {
  for (const origin of ['job', 'subagent', 'chat']) {
    for (const name of ['bash_exec', 'write_file', 'apply_patch', 'slack_send_message']) {
      const out = classifyToolRisk(name, { command: 'rm -rf /', path: '/etc/passwd' }, { origin, mode: 'off' })
      assert.deepEqual(out, { needsApproval: false, risk: 'low', reason: null }, `${name}/${origin}`)
    }
  }
})

test("mode 'unattended' passes chat origin but gates job / subagent", () => {
  assert.equal(
    classifyToolRisk('bash_exec', { command: 'ls' }, { origin: 'chat', mode: 'unattended' }).needsApproval,
    false,
  )
  for (const origin of ['job', 'subagent']) {
    assert.equal(
      classifyToolRisk('bash_exec', { command: 'ls' }, { origin, mode: 'unattended' }).needsApproval,
      true,
      `origin=${origin} should be gated`,
    )
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

test('empty / non-string tool name is never gated', () => {
  for (const name of ['', null, undefined, 0, {}, []]) {
    const out = classifyToolRisk(name, {}, { origin: 'job', mode: 'all' })
    assert.deepEqual(out, { needsApproval: false, risk: 'low', reason: null }, `name=${String(name)}`)
  }
})
