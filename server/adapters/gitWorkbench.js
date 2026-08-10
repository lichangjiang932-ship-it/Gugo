import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { resolveAuthorizedLocalPath } from '../services/localFileAccessService.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { assertWorkspaceCapability } from '../services/workspaceTrustService.js'
import { resolveForShellCwd } from './fsShellTools.js'

const MAX_OUTPUT = 1024 * 1024
const DEFAULT_TIMEOUT = 60_000
const CHECK_TIMEOUT = 5 * 60_000
const ALLOWED_CHECKS = new Set(['lint', 'test', 'build'])

function badReq(message, statusCode = 400) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

function workspaceRoot(env = getRuntimeEnv()) {
  return path.resolve(env.WORKSPACE_ROOT?.trim() || process.cwd())
}

function getRoot({
  userId = null,
  cwd: rawCwd = null,
  env = getRuntimeEnv(),
  write = false,
  capabilities = ['git'],
} = {}) {
  const requestedPath = rawCwd == null || rawCwd === '' ? workspaceRoot(env) : rawCwd
  const resolved = resolveAuthorizedLocalPath({
    userId,
    rawPath: requestedPath,
    write,
    allowWorkspace: true,
  })
  if (!fs.statSync(resolved.fullPath).isDirectory()) throw badReq('cwd must be a directory')
  for (const capability of capabilities) {
    assertWorkspaceCapability({
      userId,
      rootPath: resolved.rootPath || resolved.fullPath,
      capability,
      env,
    })
  }
  return resolved.fullPath
}

function requireGitEnabled(env = getRuntimeEnv()) {
  if (env.WORKSPACE_GIT_ENABLED !== '1') {
    throw badReq('WORKSPACE_GIT_ENABLED=1 未启用,无法使用 Git 工作台。在项目根目录的 .env 里加上这一行后重启服务。', 403)
  }
}

function requireMutationEnabled(env = getRuntimeEnv()) {
  requireGitEnabled(env)
  if (env.WORKSPACE_GIT_MUTATION_ENABLED !== '1') {
    throw badReq('WORKSPACE_GIT_MUTATION_ENABLED=1 未启用,无法 commit/push(只读的 status/diff 不受影响)。在 .env 里加上这一行后重启服务。', 403)
  }
}

// ★ P0:统一从 sanitizeChildEnv 取,自动覆盖所有 *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD
// 老实现只屏蔽 3 个固定 key,换用户配 ANTHROPIC_API_KEY/GITHUB_TOKEN 就漏了
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
function commandEnv() {
  return sanitizeChildEnv()
}

function runFile(file, args, { cwd = workspaceRoot(), timeout = DEFAULT_TIMEOUT, rejectOnError = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      env: commandEnv(),
    }, (err, stdout, stderr) => {
      const result = {
        ok: !err,
        exitCode: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!err?.killed,
      }
      if (err && rejectOnError) {
        const e = badReq(String(stderr || err.message || 'command failed').trim() || 'command failed', err.killed ? 408 : 500)
        e.result = result
        reject(e)
        return
      }
      resolve(result)
    })
  })
}

async function runGit(args, opts = {}) {
  return runFile('git', args, opts)
}

function npmCommandArgs(scriptName) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate))
  if (npmCli) return { file: process.execPath, args: [npmCli, 'run', scriptName] }
  return { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', scriptName] }
}

function normalizeRepoPath(rawPath) {
  if (rawPath == null || rawPath === '') return ''
  if (typeof rawPath !== 'string') throw badReq('path must be a string')
  const p = rawPath.replace(/\\/g, '/').trim()
  if (!p) return ''
  if (p.startsWith('-') || p.includes('\0') || path.isAbsolute(p) || p.split('/').includes('..')) {
    throw badReq('path must be a safe workspace-relative git path')
  }
  return p
}

function parsePorcelain(stdout = '') {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const status = line.slice(0, 2)
    const rawPath = line.slice(3)
    const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath
    return { status, path: filePath }
  })
}

async function currentBranch(cwd) {
  const branch = await runGit(['branch', '--show-current'], { cwd, rejectOnError: false })
  const name = branch.stdout.trim()
  return name || 'HEAD'
}

async function currentStatusFiles(cwd) {
  const status = await runGit(['status', '--porcelain=v1', '-uall'], { cwd })
  return parsePorcelain(status.stdout)
}

function clip(text, max = MAX_OUTPUT) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max) + '\n...[truncated]' : value
}

export async function gitStatusTool({ cwd: rawCwd, userId = null } = {}) {
  const env = getRuntimeEnv()
  requireGitEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env })
  const [branch, filesResult] = await Promise.all([
    currentBranch(root),
    currentStatusFiles(root),
  ])
  return {
    ok: true,
    branch,
    root,
    clean: filesResult.length === 0,
    files: filesResult,
    porcelain: filesResult.map((f) => `${f.status} ${f.path}`).join('\n'),
  }
}

export async function gitDiffTool({ path: rawPath, cwd: rawCwd, staged = false, userId = null } = {}) {
  const env = getRuntimeEnv()
  requireGitEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env })
  const repoPath = normalizeRepoPath(rawPath)
  const args = ['diff', '--no-ext-diff', '--no-color']
  if (staged) args.push('--cached')
  if (repoPath) args.push('--', repoPath)
  const diff = await runGit(args, { cwd: root, rejectOnError: false })
  const statArgs = ['diff', '--stat', '--no-ext-diff', '--no-color']
  if (staged) statArgs.push('--cached')
  if (repoPath) statArgs.push('--', repoPath)
  const stat = await runGit(statArgs, { cwd: root, rejectOnError: false })
  return {
    ok: diff.ok,
    path: repoPath || null,
    staged: Boolean(staged),
    stat: clip(stat.stdout || stat.stderr, 80_000),
    diff: clip(diff.stdout || diff.stderr),
    exitCode: diff.exitCode,
  }
}

export async function runProjectCheckTool({ check, cwd: rawCwd, userId = null } = {}) {
  const name = String(check || '').trim()
  if (!ALLOWED_CHECKS.has(name)) {
    throw badReq('run_project_check only supports lint, test, build')
  }
  const resolvedCwd = resolveForShellCwd(rawCwd, { userId })
  const root = resolvedCwd.fullPath
  if (!fs.statSync(root).isDirectory()) throw badReq('cwd must be a directory')
  const command = npmCommandArgs(name)
  const result = await runFile(command.file, command.args, {
    cwd: root,
    timeout: CHECK_TIMEOUT,
    rejectOnError: false,
  })
  return {
    ok: result.ok,
    check: name,
    command: `npm run ${name}`,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
  }
}

function validateSelectedFiles(files, statusFiles) {
  if (!Array.isArray(files) || files.length === 0) throw badReq('selected files are required')
  const changed = new Set(statusFiles.map((f) => f.path))
  const selected = files.map(normalizeRepoPath).filter(Boolean)
  if (!selected.length) throw badReq('selected files are required')
  for (const file of selected) {
    if (!changed.has(file)) throw badReq(`selected file is not changed: ${file}`)
  }
  return [...new Set(selected)]
}

export async function gitCommitTool({ message, files, cwd: rawCwd, userId = null } = {}) {
  const env = getRuntimeEnv()
  requireMutationEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env, write: true, capabilities: ['gitMutation'] })
  const msg = String(message || '').trim()
  if (msg.length < 3 || msg.length > 200) throw badReq('commit message must be 3-200 characters')
  const statusFiles = await currentStatusFiles(root)
  const selected = validateSelectedFiles(files, statusFiles)
  await runGit(['add', '--', ...selected], { cwd: root })
  const hasStaged = await runGit(['diff', '--cached', '--quiet', '--', ...selected], { cwd: root, rejectOnError: false })
  if (hasStaged.exitCode === 0) throw badReq('selected files have no staged changes')
  const commit = await runGit(['commit', '-m', msg, '--', ...selected], { cwd: root })
  const hash = await runGit(['rev-parse', 'HEAD'], { cwd: root })
  return {
    ok: true,
    commit: hash.stdout.trim(),
    summary: commit.stdout.trim(),
    files: selected,
  }
}

export async function gitPushTool({ force = false, cwd: rawCwd, userId = null } = {}) {
  const env = getRuntimeEnv()
  requireMutationEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env, write: true, capabilities: ['gitMutation'] })
  if (force) throw badReq('force push is not allowed')
  const branch = await currentBranch(root)
  if (!branch || branch === 'HEAD') throw badReq('cannot push detached HEAD')
  const result = await runGit(['push', 'origin', branch], { cwd: root, rejectOnError: false })
  if (!result.ok) {
    const err = badReq(String(result.stderr || result.stdout || 'git push failed').trim(), 500)
    err.result = result
    throw err
  }
  return {
    ok: true,
    branch,
    remote: 'origin',
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export async function gitRollbackTool({ commit, cwd: rawCwd, userId = null } = {}) {
  const env = getRuntimeEnv()
  requireMutationEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env, write: true, capabilities: ['gitMutation'] })
  const expected = String(commit || '').trim()
  if (!/^[0-9a-f]{7,40}$/i.test(expected)) {
    throw badReq('rollback commit must be a 7-40 character hexadecimal hash')
  }

  const statusFiles = await currentStatusFiles(root)
  if (statusFiles.length) {
    throw badReq('rollback requires a clean working tree; commit or discard current changes first')
  }

  const headResult = await runGit(['rev-parse', 'HEAD'], { cwd: root })
  const head = headResult.stdout.trim()
  const expectedResult = await runGit(['rev-parse', '--verify', `${expected}^{commit}`], {
    cwd: root,
    rejectOnError: false,
  })
  const resolvedExpected = expectedResult.stdout.trim()
  if (!expectedResult.ok || !resolvedExpected || resolvedExpected !== head) {
    throw badReq('rollback is restricted to the current HEAD commit')
  }

  const reverted = await runGit(['revert', '--no-edit', head], { cwd: root, rejectOnError: false })
  if (!reverted.ok) {
    await runGit(['revert', '--abort'], { cwd: root, rejectOnError: false })
    const err = badReq(String(reverted.stderr || reverted.stdout || 'git revert failed').trim(), 500)
    err.result = reverted
    throw err
  }
  const rollbackHead = await runGit(['rev-parse', 'HEAD'], { cwd: root })
  return {
    ok: true,
    revertedCommit: head,
    rollbackCommit: rollbackHead.stdout.trim(),
    summary: reverted.stdout.trim(),
  }
}

export async function dispatchGitTool(name, args, { userId = null } = {}) {
  const argsWithUser = userId ? { ...(args || {}), userId } : (args || {})
  switch (name) {
    case 'git_status': return gitStatusTool(argsWithUser)
    case 'git_diff': return gitDiffTool(argsWithUser)
    case 'run_project_check': return runProjectCheckTool(argsWithUser)
    case 'git_commit': return gitCommitTool(argsWithUser)
    case 'git_push': return gitPushTool(argsWithUser)
    case 'git_rollback': return gitRollbackTool(argsWithUser)
    default: throw badReq(`unknown git tool: ${name}`, 404)
  }
}

export async function handleGitWorkbenchRequest(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
  if (!authenticateRequest(req)) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
  const url = new URL(req.url || '/', 'http://localhost')
  try {
    const body = await readJson(req)
    const bodyWithUser = { ...body, userId: req.userId }
    let result
    if (url.pathname === '/api/tools/git/status' || url.pathname === '/api/workbench/git/status') result = await gitStatusTool(bodyWithUser)
    else if (url.pathname === '/api/tools/git/diff' || url.pathname === '/api/workbench/git/diff') result = await gitDiffTool(bodyWithUser)
    else if (url.pathname === '/api/tools/check/run' || url.pathname === '/api/workbench/check/run') result = await runProjectCheckTool(bodyWithUser)
    else if (url.pathname === '/api/workbench/git/commit') result = await gitCommitTool(bodyWithUser)
    else if (url.pathname === '/api/workbench/git/push') result = await gitPushTool(bodyWithUser)
    else if (url.pathname === '/api/workbench/git/rollback') result = await gitRollbackTool(bodyWithUser)
    else return sendJson(res, 404, { ok: false, error: 'not found' })
    return sendJson(res, 200, result)
  } catch (err) {
    const status = err?.statusCode || 500
    return sendJson(res, status, {
      ok: false,
      code: err?.code || 'GIT_WORKBENCH_FAILED',
      error: err?.message || 'git workbench failed',
      retryable: err?.retryable ?? ![401, 403, 404].includes(status),
      result: err?.result,
      ...(err?.path ? { path: err.path } : {}),
      ...(err?.hint ? { hint: err.hint } : {}),
      ...(err?.suggestGrantPath ? { suggestGrantPath: err.suggestGrantPath } : {}),
      ...(err?.requiredAccessMode ? { requiredAccessMode: err.requiredAccessMode } : {}),
    })
  }
}

export const GIT_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Read git branch and changed files from the workspace or a user-authorized repository. Read-only. Use before and after code edits.',
      parameters: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Read unified git diff for the whole workspace or one changed file. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repository-relative file path.' },
          staged: { type: 'boolean', description: 'When true, read the staged (cached) diff instead of the working-tree diff.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_project_check',
      description: 'Run one allowed project verification command: lint, test, or build. Does not accept arbitrary shell.',
      parameters: {
        type: 'object',
        properties: {
          check: { type: 'string', enum: ['lint', 'test', 'build'] },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
        required: ['check'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Commit only explicitly selected changed files. Requires WORKSPACE_GIT_MUTATION_ENABLED=1 and interactive approval.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', minLength: 3, maxLength: 200 },
          files: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', description: 'Repository-relative changed file path.' },
          },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
        required: ['message', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Push the current branch to origin without force. Requires WORKSPACE_GIT_MUTATION_ENABLED=1 and interactive approval.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_rollback',
      description: 'Safely roll back a failed committed change by reverting the current HEAD into a new commit. Never resets history or overwrites a dirty working tree.',
      parameters: {
        type: 'object',
        properties: {
          commit: { type: 'string', description: 'Expected current HEAD commit hash returned by git_commit.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
        required: ['commit'],
      },
    },
  },
]
