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
  gitRollbackTool,
  gitWriteTool,
  GIT_TOOL_SPECS,
} from '../server/adapters/gitWorkbench.js'
import { createUser, setUserToolPermission } from '../server/db.js'

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
  const effectiveVars = { WORKSPACE_SHARED_TRUSTED: '1', ...vars }
  const old = {}
  for (const [key, value] of Object.entries(effectiveVars)) {
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
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '0' }, async () => {
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

    git(cwd, ['add', 'README.md'])
    const stagedDiff = await gitDiffTool({ path: 'README.md', staged: true })
    assert.equal(stagedDiff.staged, true)
    assert.match(stagedDiff.diff, /changed/)
    const workingDiff = await gitDiffTool({ path: 'README.md' })
    assert.equal(workingDiff.diff, '')
  })
})

test('run_project_check only allows lint/test/build scripts', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '0', WORKSPACE_SHELL_ENABLED: '1' }, async () => {
    const lint = await runProjectCheckTool({ check: 'lint' })
    assert.equal(lint.ok, true)
    assert.match(lint.stdout, /lint-ok/)
    await assert.rejects(() => runProjectCheckTool({ check: 'start' }), /only supports lint, test, build/)
  })
})

test('run_project_check requires shell authorization instead of the Git gate', async () => {
  const cwd = withTempRepo()
  await withEnv({ WORKSPACE_ROOT: cwd, WORKSPACE_GIT_ENABLED: '1', WORKSPACE_SHELL_ENABLED: '0' }, async () => {
    await assert.rejects(
      () => runProjectCheckTool({ check: 'test' }),
      (error) => error?.code === 'WORKSPACE_SHELL_DISABLED',
    )
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

test('git mutation tools are exposed to autonomous jobs', () => {
  const names = new Set(GIT_TOOL_SPECS.map((spec) => spec.function.name))
  assert.equal(names.has('git_commit'), true)
  assert.equal(names.has('git_push'), true)
  assert.equal(names.has('git_rollback'), true)
  assert.equal(names.has('git_write'), true)
})

test('git_write creates and checks out branches without shell interpolation', async () => {
  const cwd = withTempRepo()
  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    const created = await gitWriteTool({ action: 'branch', branch: 'feat/structured-write' })
    assert.equal(created.ok, true)
    assert.equal(created.action, 'create_branch')
    assert.equal(git(cwd, ['branch', '--show-current']).trim(), 'feat/structured-write')

    const checkedOut = await gitWriteTool({ action: 'checkout', branch: 'master' })
    assert.equal(checkedOut.ok, true)
    assert.equal(git(cwd, ['branch', '--show-current']).trim(), 'master')
  })
})

test('git_write commit uses explicit selected files and checkout rejects dirty worktrees', async () => {
  const cwd = withTempRepo()
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\nstructured\n', 'utf8')
  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    const committed = await gitWriteTool({
      action: 'commit',
      message: 'feat: structured git write',
      files: ['README.md'],
    })
    assert.equal(committed.ok, true)
    assert.equal(committed.action, 'commit')
    assert.match(committed.commit, /^[0-9a-f]{40}$/u)

    await gitWriteTool({ action: 'branch', branch: 'feat/dirty-target' })
    await gitWriteTool({ action: 'checkout', branch: 'master' })
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'dirty\n', 'utf8')
    await assert.rejects(
      () => gitWriteTool({ action: 'checkout', branch: 'feat/dirty-target' }),
      /clean working tree/,
    )
  })
})

test('git_status and git_write preserve Unicode rename paths and commit both sides', async () => {
  const cwd = withTempRepo()
  const originalPath = '旧文档.txt'
  const renamedPath = '新文档.txt'
  fs.writeFileSync(path.join(cwd, originalPath), '中文内容\n', 'utf8')
  git(cwd, ['add', '--', originalPath])
  git(cwd, ['commit', '-m', 'test: add unicode file'])
  git(cwd, ['mv', '--', originalPath, renamedPath])

  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    const status = await gitStatusTool()
    assert.deepEqual(status.files, [{
      status: 'R ',
      path: renamedPath,
      originalPath,
    }])

    const committed = await gitWriteTool({
      action: 'commit',
      message: 'test: rename unicode file',
      files: [renamedPath],
    })
    assert.equal(committed.ok, true)
    assert.deepEqual(committed.files, [renamedPath])
    assert.equal(git(cwd, ['status', '--porcelain=v1']), '')
    assert.match(
      git(cwd, ['-c', 'core.quotePath=false', 'show', '--name-status', '--format=', 'HEAD']),
      new RegExp(`R\\d+\\s+${originalPath}\\s+${renamedPath}`),
    )
  })
})

test('git_write commit checks its alias permission without inheriting the legacy git_commit switch', async () => {
  const cwd = withTempRepo()
  const userId = `git-write-permission-${process.pid}`
  createUser({ id: userId, email: `${userId}@example.com` })
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\npermission gate\n', 'utf8')

  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    setUserToolPermission({ userId, toolName: 'git_write', enabled: false })
    setUserToolPermission({ userId, toolName: 'git_commit', enabled: true })
    await assert.rejects(
      () => gitWriteTool({
        action: 'commit',
        message: 'test: alias gate',
        files: ['README.md'],
        userId,
      }),
      (error) => error?.code === 'TOOL_DISABLED' && /git_write/u.test(error.message),
    )

    setUserToolPermission({ userId, toolName: 'git_write', enabled: true })
    setUserToolPermission({ userId, toolName: 'git_commit', enabled: false })
    await assert.rejects(
      () => gitCommitTool({
        message: 'test: request injection is ignored',
        files: ['README.md'],
        userId,
        permissionToolName: 'git_write',
      }),
      (error) => error?.code === 'TOOL_DISABLED' && /git_commit/u.test(error.message),
    )

    const committed = await gitWriteTool({
      action: 'commit',
      message: 'test: canonical alias gate',
      files: ['README.md'],
      userId,
    })
    assert.equal(committed.ok, true)
    assert.equal(committed.action, 'commit')
    assert.match(committed.commit, /^[0-9a-f]{40}$/u)
  })
})

test('git_write push checks its alias permission without inheriting the legacy git_push switch', async () => {
  const cwd = withTempRepo()
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-git-remote-'))
  git(remote, ['init', '--bare'])
  git(cwd, ['remote', 'add', 'origin', remote])
  const userId = `git-push-permission-${process.pid}`
  createUser({ id: userId, email: `${userId}@example.com` })

  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    setUserToolPermission({ userId, toolName: 'git_write', enabled: true })
    setUserToolPermission({ userId, toolName: 'git_push', enabled: false })
    await assert.rejects(
      () => gitPushTool({
        userId,
        permissionToolName: 'git_write',
      }),
      (error) => error?.code === 'TOOL_DISABLED' && /git_push/u.test(error.message),
    )

    const pushed = await gitWriteTool({ action: 'push', userId })
    assert.equal(pushed.ok, true, JSON.stringify(pushed))
    assert.equal(pushed.action, 'push')
    assert.equal(pushed.branch, 'master')
    assert.equal(git(remote, ['rev-parse', 'refs/heads/master']).trim(), git(cwd, ['rev-parse', 'HEAD']).trim())
  })
})

test('git_rollback reverts only the clean current HEAD without rewriting history', async () => {
  const cwd = withTempRepo()
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\nchanged\n', 'utf8')
  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    const committed = await gitCommitTool({ message: 'feat: change readme', files: ['README.md'] })
    const rollback = await gitRollbackTool({ commit: committed.commit })
    assert.equal(rollback.ok, true)
    assert.equal(rollback.revertedCommit, committed.commit)
    assert.notEqual(rollback.rollbackCommit, committed.commit)
    assert.equal(
      fs.readFileSync(path.join(cwd, 'README.md'), 'utf8').replace(/\r\n/g, '\n'),
      'hello\n',
    )
    assert.match(git(cwd, ['log', '-1', '--pretty=%s']), /^Revert /)
  })
})

test('git_rollback refuses dirty worktrees and non-HEAD commits', async () => {
  const cwd = withTempRepo()
  const initial = git(cwd, ['rev-parse', 'HEAD']).trim()
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\nchanged\n', 'utf8')
  await withEnv({
    WORKSPACE_ROOT: cwd,
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  }, async () => {
    const committed = await gitCommitTool({ message: 'feat: change readme', files: ['README.md'] })
    await assert.rejects(() => gitRollbackTool({ commit: initial }), /current HEAD/)
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'keep me\n', 'utf8')
    await assert.rejects(() => gitRollbackTool({ commit: committed.commit }), /clean working tree/)
    assert.equal(fs.readFileSync(path.join(cwd, 'dirty.txt'), 'utf8'), 'keep me\n')
  })
})
