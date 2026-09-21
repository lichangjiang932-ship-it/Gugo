import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  dispatchGitHistoryTool,
  GIT_HISTORY_TOOL_SPECS,
  gitBlameTool,
  gitLogTool,
  isGitHistoryTool,
} from '../server/adapters/gitHistoryTools.js'
import { getBuiltinSpec, getToolMetadata } from '../server/utils/toolSchemaCatalog.js'
import { isLocalMutationCall, isVerificationCall } from '../server/services/toolLoopHeuristics.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function withTempRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-git-history-'))
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'history@example.com'])
  git(cwd, ['config', 'user.name', 'History Tester'])
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const one = 1\nconst two = 2\n', 'utf8')
  fs.mkdirSync(path.join(cwd, 'src'))
  fs.writeFileSync(path.join(cwd, 'src', 'lib.js'), 'export const lib = true\n', 'utf8')
  git(cwd, ['add', '.'])
  git(cwd, ['-c', 'user.name=First Author', 'commit', '-m', 'feat: initial commit'])
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const one = 1\nconst two = 2\nconst three = 3\n', 'utf8')
  git(cwd, ['add', 'app.js'])
  git(cwd, ['-c', 'user.name=Second Author', 'commit', '-m', 'feat: add three'])
  return cwd
}

function withEnv(vars, fn) {
  const effective = { WORKSPACE_SHARED_TRUSTED: '1', WORKSPACE_GIT_ENABLED: '1', ...vars }
  const previous = new Map()
  for (const [key, value] of Object.entries(effective)) {
    previous.set(key, process.env[key])
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('git_log reads recent commits newest first and bounds the request', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd }, async () => {
    const log = await gitLogTool({ limit: 2 })
    assert.equal(log.ok, true)
    assert.equal(log.commits.length, 2)
    assert.equal(log.commits[0].subject, 'feat: add three')
    assert.equal(log.commits[0].author, 'Second Author')
    assert.equal(log.commits[1].subject, 'feat: initial commit')
    assert.match(log.commits[0].commit, /^[0-9a-f]{7,40}$/u)
    assert.match(log.commits[0].date, /^\d{4}-\d{2}-\d{2}$/u)

    // A path limits history to that file, and an explicit bound is clamped.
    const scoped = await gitLogTool({ path: 'src/lib.js' })
    assert.deepEqual(scoped.commits.map((entry) => entry.subject), ['feat: initial commit'])
    assert.equal((await gitLogTool({ limit: 10_000 })).limit, 100)
    assert.equal((await gitLogTool({ limit: 0 })).limit, 1)
  })
})

test('git_log rejects a malformed since filter instead of guessing', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd }, async () => {
    for (const since of ['yesterday', '2026-13-01', '--all', '2026/09/21']) {
      const result = await gitLogTool({ since })
      assert.equal(result.ok, false, since)
      assert.equal(result.code, 'GIT_LOG_SINCE_INVALID', since)
    }
    // A well-formed bound is accepted; a future bound simply returns nothing.
    assert.equal((await gitLogTool({ since: '2000-01-01' })).ok, true)
    assert.deepEqual((await gitLogTool({ since: '2099-01-01' })).commits, [])
  })
})

test('git_blame reports per-line authorship over the requested range', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd }, async () => {
    const blame = await gitBlameTool({ path: 'app.js', line_count: 3 })
    assert.equal(blame.ok, true)
    assert.deepEqual(blame.lines.map((line) => line.line), [1, 2, 3])
    assert.equal(blame.lines[0].content, 'const one = 1')
    assert.equal(blame.lines[0].author, 'First Author')
    assert.equal(blame.lines[2].author, 'Second Author', 'the third line came from the later commit')
    assert.match(blame.lines[0].date, /^\d{4}-\d{2}-\d{2}$/u)

    const ranged = await gitBlameTool({ path: 'app.js', start_line: 2, line_count: 1 })
    assert.deepEqual(ranged.lines.map((line) => line.line), [2])
    assert.equal(ranged.lines[0].content, 'const two = 2')
    assert.equal((await gitBlameTool({ path: 'app.js', line_count: 9_999 })).lineCount, 200)
  })
})

test('git_blame requires a path and reports an unreadable history clearly', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd }, async () => {
    const missing = await gitBlameTool({})
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'GIT_BLAME_PATH_REQUIRED')

    // A file that exists on disk but not in HEAD has no history to read.
    fs.writeFileSync(path.join(cwd, 'untracked.js'), 'export const x = 1\n', 'utf8')
    const untracked = await gitBlameTool({ path: 'untracked.js', line_count: 1 })
    assert.equal(untracked.ok, false)
    assert.equal(untracked.code, 'GIT_HISTORY_FAILED')

    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-not-a-repo-'))
    await withEnv({ WORKSPACE_ROOT: nonRepo }, async () => {
      const result = await gitLogTool({})
      assert.equal(result.ok, false)
      assert.equal(result.code, 'GIT_NOT_REPOSITORY')
      assert.deepEqual(result.commits, [])
    })
  })
})

test('history tools are read-only, need no approval, and are never verification', async () => {
  for (const name of ['git_log', 'git_blame']) {
    const metadata = getToolMetadata(name, { args: {} })
    assert.equal(metadata.isReadOnly, true, name)
    assert.equal(metadata.requiredApproval, false, name)
    assert.equal(metadata.isDestructive, false, name)
    assert.equal(metadata.executionMode, 'parallel', name)
    assert.ok(getBuiltinSpec(name), `${name} must be published in the tool catalog`)

    const call = { name, args: { path: 'app.js' } }
    // A log or a blame line reports history, not the state of the change under
    // verification, so it must not clear pending mutation debt.
    assert.equal(isVerificationCall(call), false, name)
    assert.equal(isLocalMutationCall(call), false, name)
  }
  assert.deepEqual(GIT_HISTORY_TOOL_SPECS.map((spec) => spec.function.name), ['git_log', 'git_blame'])
  assert.equal(isGitHistoryTool('git_log'), true)
  assert.equal(isGitHistoryTool('git_diff'), false)
})

test('the history dispatcher routes both tools and rejects anything else', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd }, async () => {
    assert.equal((await dispatchGitHistoryTool('git_log', { limit: 1 })).ok, true)
    assert.equal((await dispatchGitHistoryTool('git_blame', { path: 'app.js', line_count: 1 })).ok, true)
    assert.throws(() => dispatchGitHistoryTool('git_status', {}), /unknown git history tool/u)
  })
})

test('history tools are offered in chat, plan and code modes without approval', async () => {
  const { NEVER_APPROVE_TOOLS } = await import('../server/utils/approvalPolicy.js')
  const { resolveSpecsForMode } = await import('../server/utils/toolSchemaCatalog.js')
  for (const mode of ['chat', 'plan', 'code']) {
    const names = resolveSpecsForMode(mode).map((spec) => spec.name)
    for (const name of ['git_log', 'git_blame']) {
      assert.ok(names.includes(name), `${name} must be exposed in ${mode} mode`)
      assert.equal(NEVER_APPROVE_TOOLS.includes(name), true, `${name} must never require approval`)
    }
  }
})

test('a general sub-agent may read history, and a planning explorer is told it may', async () => {
  const { SUBAGENT_TYPES } = await import('../server/services/subagentRuntimePolicy.js')
  const general = (SUBAGENT_TYPES.general.tools || []).map((spec) => spec?.function?.name || '')
  for (const name of ['git_log', 'git_blame']) {
    assert.ok(general.includes(name), `a general sub-agent must be able to call ${name}`)
  }
  // The explore/plan read-only allowlist deliberately has no Git tools at all;
  // history must not become the first one through that door.
  const explore = (SUBAGENT_TYPES.explore.tools || []).map((spec) => spec?.function?.name || '')
  assert.equal(explore.includes('git_log'), false)
  assert.equal(explore.includes('git_status'), false)

  // Assert the published list, not a private table: a guarded import would have
  // made this a silent no-op.
  const { selectPlanningToolSpecs } = await import('../server/services/jobPlanningExplorationRuntime.js')
  const planned = selectPlanningToolSpecs('map how the checkout flow changed').map((spec) => spec.function.name)
  assert.ok(planned.includes('git_log'), 'a planning explorer must be offered git_log')
  assert.ok(planned.includes('git_blame'), 'a planning explorer must be offered git_blame')
  // The set is a filter, so anything outside it must stay out.
  assert.equal(planned.includes('write_file'), false)
})
