import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import {
  gitStatusTool,
  gitDiffTool,
  runProjectCheckTool,
  gitCommitTool,
  gitPushTool,
} from '../server/gitWorkbench.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function withTempRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-git-'))
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test User'])
  fs.writeFileSync(path.join(cwd, 'lint-ok.js'), "console.log('lint-ok')\n", 'utf8')
  fs.writeFileSync(path.join(cwd, 'test-ok.js'), "console.log('test-ok')\n", 'utf8')
  fs.writeFileSync(path.join(cwd, 'build-ok.js'), "console.log('build-ok')\n", 'utf8')
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    scripts: {
      lint: 'node lint-ok.js',
      test: 'node test-ok.js',
      build: 'node build-ok.js',
    },
  }), 'utf8')
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\n', 'utf8')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'init'])
  return cwd
}

function withEnv(vars, fn) {
  const old = {}
  for (const [key, value] of Object.entries(vars)) {
    old[key] = process.env[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(old)) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
      }
    })
}

test('git_status requires WORKSPACE_GIT_ENABLED', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: null }, async () => {
    await assert.rejects(() => gitStatusTool(), /WORKSPACE_GIT_ENABLED=1/)
  })
})

test('git_status and git_diff report workspace changes', async () => {
  const cwd = withTempRepo()
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\nchanged\n', 'utf8')
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'new file\n', 'utf8')
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '1' }, async () => {
    const status = await gitStatusTool()
    assert.equal(status.ok, true)
    assert.equal(status.branch, 'master')
    assert.deepEqual(status.files.map((f) => f.path).sort(), ['README.md', 'new.txt'])

    const diff = await gitDiffTool({ path: 'README.md' })
    assert.equal(diff.ok, true)
    assert.match(diff.diff, /changed/)
    assert.doesNotMatch(diff.diff, /new file/)
  })
})

test('run_project_check only allows lint/test/build scripts', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '1' }, async () => {
    const lint = await runProjectCheckTool({ check: 'lint' })
    assert.equal(lint.ok, true)
    assert.match(lint.stdout, /lint-ok/)
    await assert.rejects(() => runProjectCheckTool({ check: 'start' }), /only supports lint, test, build/)
  })
})

test('git_commit requires mutation gate, non-empty message, selected changed files', async () => {
  const cwd = withTempRepo()
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\nchanged\n', 'utf8')
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '1', WORKSPACE_GIT_MUTATION_ENABLED: null }, async () => {
    await assert.rejects(() => gitCommitTool({ message: 'feat: nope', files: ['README.md'] }), /WORKSPACE_GIT_MUTATION_ENABLED=1/)
  })
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '1', WORKSPACE_GIT_MUTATION_ENABLED: '1' }, async () => {
    await assert.rejects(() => gitCommitTool({ message: 'x', files: ['README.md'] }), /commit message/)
    await assert.rejects(() => gitCommitTool({ message: 'feat: empty', files: [] }), /selected files/)
    const commit = await gitCommitTool({ message: 'feat: update readme', files: ['README.md'] })
    assert.equal(commit.ok, true)
    assert.match(commit.commit, /^[0-9a-f]{7,40}$/)
    assert.match(git(cwd, ['log', '-1', '--pretty=%s']), /feat: update readme/)
  })
})

test('git_push rejects force push requests', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '1', WORKSPACE_GIT_MUTATION_ENABLED: '1' }, async () => {
    await assert.rejects(() => gitPushTool({ force: true }), /force push is not allowed/)
  })
})
