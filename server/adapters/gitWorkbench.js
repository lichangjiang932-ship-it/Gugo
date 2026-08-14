import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { isToolPermittedForUser } from '../db.js'
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

export function npmCommandArgs(scriptName, {
  npmExecPath = process.env.npm_execpath,
  executablePath = process.execPath,
  platform = process.platform,
  commandInterpreter = process.env.ComSpec,
  fileExists = fs.existsSync,
} = {}) {
  const candidates = [
    npmExecPath,
    path.join(path.dirname(executablePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find((candidate) => fileExists(candidate))
  if (npmCli) return { file: executablePath, args: [npmCli, 'run', scriptName] }
  if (platform === 'win32') {
    return {
      file: commandInterpreter || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', scriptName],
    }
  }
  return { file: 'npm', args: ['run', scriptName] }
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

function parsePorcelainZ(stdout = '') {
  const records = String(stdout || '').split('\0')
  const files = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const status = record.slice(0, 2)
    const filePath = record.slice(3)
    const renamed = status.includes('R') || status.includes('C')
    const originalPath = renamed ? String(records[index + 1] || '') : ''
    if (renamed) index += 1
    files.push({
      status,
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
    })
  }
  return files
}

async function currentBranch(cwd) {
  const branch = await runGit(['branch', '--show-current'], { cwd, rejectOnError: false })
  const name = branch.stdout.trim()
  return name || 'HEAD'
}

async function currentStatusFiles(cwd) {
  // `-z` is machine-readable: paths are never C-quoted, newlines remain
  // unambiguous, and rename/copy records carry the destination and source as
  // separate NUL-delimited fields. This keeps Chinese and other Unicode paths
  // exact regardless of the user's core.quotePath setting.
  const status = await runGit(['status', '--porcelain=v1', '-z', '-uall'], { cwd })
  return parsePorcelainZ(status.stdout)
}

function assertGitToolPermitted(userId, toolName) {
  if (!userId || isToolPermittedForUser(userId, toolName)) return
  const error = badReq(`工具 ${toolName} 已被该用户在权限中心关闭`, 403)
  error.code = 'TOOL_DISABLED'
  throw error
}

function effectivePermissionToolName(permissionToolName, fallback) {
  return typeof permissionToolName === 'string' && permissionToolName.trim()
    ? permissionToolName.trim()
    : fallback
}

async function requireCleanWorkingTree(cwd, action) {
  const files = await currentStatusFiles(cwd)
  if (files.length > 0) {
    throw badReq(`${action} requires a clean working tree; commit the current changes first`)
  }
}

async function validateBranchName(rawBranch, cwd) {
  const branch = String(rawBranch || '').trim()
  if (!branch || branch.startsWith('-') || branch.length > 240 || branch.includes('\0')) {
    throw badReq('branch must be a valid local branch name')
  }
  const checked = await runGit(['check-ref-format', '--branch', branch], { cwd, rejectOnError: false })
  if (!checked.ok) throw badReq(`invalid branch name: ${branch}`)
  return branch
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
  const changed = new Map(statusFiles.map((file) => [file.path, file]))
  const selected = files.map(normalizeRepoPath).filter(Boolean)
  if (!selected.length) throw badReq('selected files are required')
  for (const file of selected) {
    if (!changed.has(file)) throw badReq(`selected file is not changed: ${file}`)
  }
  return [...new Set(selected)]
}

function selectiveCommitPathspecs(statusFiles, selected) {
  const selectedPaths = new Set(selected)
  const excludedPaths = statusFiles.flatMap((file) => (
    selectedPaths.has(file.path) ? [] : [file.path, file.originalPath].filter(Boolean)
  ))
  return [
    ':(top,glob)**',
    ...[...new Set(excludedPaths)].map((file) => `:(top,exclude,literal)${file}`),
  ]
}

export async function gitCommitTool(
  { message, files, cwd: rawCwd, userId = null } = {},
  { permissionToolName = 'git_commit' } = {},
) {
  assertGitToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'git_commit'))
  const env = getRuntimeEnv()
  requireMutationEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env, write: true, capabilities: ['gitMutation'] })
  const msg = String(message || '').trim()
  if (msg.length < 3 || msg.length > 200) throw badReq('commit message must be 3-200 characters')
  const statusFiles = await currentStatusFiles(root)
  const selected = validateSelectedFiles(files, statusFiles)
  await runGit(['add', '-A', '--', ...selected], { cwd: root })
  const hasStaged = await runGit(['diff', '--cached', '--quiet', '--', ...selected], { cwd: root, rejectOnError: false })
  if (hasStaged.exitCode === 0) throw badReq('selected files have no staged changes')
  const commit = await runGit([
    'commit',
    '-m',
    msg,
    '--',
    ...selectiveCommitPathspecs(await currentStatusFiles(root), selected),
  ], { cwd: root })
  const hash = await runGit(['rev-parse', 'HEAD'], { cwd: root })
  return {
    ok: true,
    commit: hash.stdout.trim(),
    summary: commit.stdout.trim(),
    files: selected,
  }
}

export async function gitPushTool(
  { force = false, cwd: rawCwd, userId = null } = {},
  { permissionToolName = 'git_push' } = {},
) {
  assertGitToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'git_push'))
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
  assertGitToolPermitted(userId, 'git_rollback')
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

export async function gitWriteTool({
  action,
  branch,
  message,
  files,
  cwd: rawCwd,
  userId = null,
} = {}) {
  assertGitToolPermitted(userId, 'git_write')
  const operation = String(action || '').trim().toLowerCase()
  if (operation === 'commit') {
    return {
      action: operation,
      ...await gitCommitTool(
        { message, files, cwd: rawCwd, userId },
        { permissionToolName: 'git_write' },
      ),
    }
  }
  if (operation === 'push') {
    return {
      action: operation,
      ...await gitPushTool(
        { cwd: rawCwd, userId },
        { permissionToolName: 'git_write' },
      ),
    }
  }

  const env = getRuntimeEnv()
  requireMutationEnabled(env)
  const root = getRoot({ userId, cwd: rawCwd, env, write: true, capabilities: ['gitMutation'] })

  if (operation === 'branch' || operation === 'create_branch') {
    const target = await validateBranchName(branch, root)
    const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], {
      cwd: root,
      rejectOnError: false,
    })
    if (exists.ok) throw badReq(`local branch already exists: ${target}`)
    const created = await runGit(['switch', '-c', target], { cwd: root, rejectOnError: false })
    if (!created.ok) throw badReq(String(created.stderr || created.stdout || 'git branch creation failed').trim(), 500)
    return { ok: true, action: 'create_branch', branch: target, stdout: created.stdout, stderr: created.stderr }
  }

  if (operation === 'checkout') {
    await requireCleanWorkingTree(root, 'checkout')
    const target = await validateBranchName(branch, root)
    const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], {
      cwd: root,
      rejectOnError: false,
    })
    if (!exists.ok) throw badReq(`local branch does not exist: ${target}`)
    const switched = await runGit(['switch', target], { cwd: root, rejectOnError: false })
    if (!switched.ok) throw badReq(String(switched.stderr || switched.stdout || 'git checkout failed').trim(), 500)
    return { ok: true, action: operation, branch: target, stdout: switched.stdout, stderr: switched.stderr }
  }

  if (operation === 'pull') {
    await requireCleanWorkingTree(root, 'pull')
    const current = await currentBranch(root)
    if (!current || current === 'HEAD') throw badReq('cannot pull from detached HEAD')
    if (branch) {
      const expected = await validateBranchName(branch, root)
      if (expected !== current) throw badReq(`requested branch ${expected} is not the current branch ${current}`)
    }
    const pulled = await runGit(['pull', '--ff-only', 'origin', current], { cwd: root, rejectOnError: false })
    if (!pulled.ok) throw badReq(String(pulled.stderr || pulled.stdout || 'git pull --ff-only failed').trim(), 500)
    return { ok: true, action: operation, branch: current, remote: 'origin', stdout: pulled.stdout, stderr: pulled.stderr }
  }

  throw badReq('git_write action must be commit, branch, create_branch, checkout, pull, or push')
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
    case 'git_write': return gitWriteTool(argsWithUser)
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
      name: 'git_write',
      description: 'Perform one structured Git mutation: commit selected files, create a branch, checkout an existing clean branch, fast-forward-only pull, or non-force push. Requires Git mutation permission and per-call approval.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['commit', 'branch', 'create_branch', 'checkout', 'pull', 'push'] },
          branch: { type: 'string', description: 'Required for branch/create_branch/checkout; optional current-branch assertion for pull.' },
          message: { type: 'string', minLength: 3, maxLength: 200, description: 'Required for commit.' },
          files: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', description: 'Explicit repository-relative changed path for commit.' },
          },
          cwd: { type: 'string', description: 'Workspace-relative or authorized absolute repository path.' },
        },
        required: ['action'],
      },
    },
  },
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
