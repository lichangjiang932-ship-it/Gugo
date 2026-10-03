import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { gitDiffTool } from '../server/adapters/gitWorkbench.js'
import { normalizeToolResult } from '../server/utils/toolCallErrors.js'

async function isolatedWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-git-diagnostics-'))
  const overrides = { WORKSPACE_ROOT: root, WORKSPACE_SHARED_TRUSTED: '1', WORKSPACE_GIT_ENABLED: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))
  try {
    Object.assign(process.env, overrides)
    await run(root)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('git_diff in an authorized non-repository gives a short actionable failure, not a duplicated help page', async () => {
  await isolatedWorkspace(async (root) => {
    for (const staged of [false, true]) {
      const result = normalizeToolResult(await gitDiffTool({ cwd: root, staged }))
      assert.equal(result.ok, false)
      assert.equal(result.code, 'GIT_NOT_REPOSITORY', JSON.stringify(result))
      assert.equal(result.retryable, false)
      assert.match(result.error, /Git/)
      assert.match(result.hint, /read_file/)
      assert.equal(result.diff, '')
      assert.equal(result.stat, '')
      assert.notEqual(result.exitCode, 0)
      assert.doesNotMatch(JSON.stringify(result), /\[object Object\]|diff output format|usage: git diff/i)
      assert.ok(JSON.stringify(result).length < 1500)
      assert.equal(fs.existsSync(path.join(root, '.git')), false, 'diagnosis must not initialize a repository')
    }
  })
})

test('real repository diffs still distinguish clean, unstaged and staged changes', async () => {
  await isolatedWorkspace(async (root) => {
    const git = (args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: 'pipe' })
    git(['init', '--quiet'])
    assert.equal((await gitDiffTool({ cwd: root })).ok, true)
    fs.writeFileSync(path.join(root, 'sample.txt'), 'before\n')
    git(['add', 'sample.txt'])
    fs.writeFileSync(path.join(root, 'sample.txt'), 'after\n')
    const unstaged = await gitDiffTool({ cwd: root, path: 'sample.txt' })
    assert.equal(unstaged.ok, true)
    assert.match(unstaged.diff, /\+after/)
    assert.match(unstaged.stat, /sample.txt/)
    const staged = await gitDiffTool({ cwd: root, path: 'sample.txt', staged: true })
    assert.equal(staged.ok, true)
    assert.match(staged.diff, /\+before/)
    await assert.rejects(() => gitDiffTool({ cwd: root, path: '../outside.txt' }), /safe workspace-relative/)
    process.env.WORKSPACE_GIT_ENABLED = '0'
    await assert.rejects(() => gitDiffTool({ cwd: root }), /WORKSPACE_GIT_ENABLED/)
  })
})
