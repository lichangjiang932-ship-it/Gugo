import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { authenticateRequest } from './middleware.js'
import { readJson, sendJson } from './utils.js'

const MAX_OUTPUT = 1024 * 1024
const DEFAULT_TIMEOUT = 60_000
const CHECK_TIMEOUT = 5 * 60_000
const ALLOWED_CHECKS = new Set(['lint', 'test', 'build'])

function badReq(message, statusCode = 400) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
}

function requireGitEnabled() {
  if (process.env.WORKSPACE_GIT_ENABLED !== '1') {
    throw badReq('WORKSPACE_GIT_ENABLED=1 is required for git workbench tools', 403)
  }
}

function requireMutationEnabled() {
  requireGitEnabled()
  if (process.env.WORKSPACE_GIT_MUTATION_ENABLED !== '1') {
    throw badReq('WORKSPACE_GIT_MUTATION_ENABLED=1 is required for commit/push', 403)
  }
}

function commandEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.startsWith('=')) continue
    if (value == null) continue
    env[key] = String(value)
  }
  env.MODEL_API_KEY = ''
  env.OPENAI_API_KEY = ''
  env.MAIL_PASSWORD = ''
  return env
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

async function currentBranch() {
  const branch = await runGit(['branch', '--show-current'], { rejectOnError: false })
  const name = branch.stdout.trim()
  return name || 'HEAD'
}

async function currentStatusFiles() {
  const status = await runGit(['status', '--porcelain=v1', '-uall'])
  return parsePorcelain(status.stdout)
}

function clip(text, max = MAX_OUTPUT) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max) + '\n...[truncated]' : value
}

export async function gitStatusTool() {
  requireGitEnabled()
  const [branch, filesResult] = await Promise.all([
    currentBranch(),
    currentStatusFiles(),
  ])
  return {
    ok: true,
    branch,
    root: workspaceRoot(),
    clean: filesResult.length === 0,
    files: filesResult,
    porcelain: filesResult.map((f) => `${f.status} ${f.path}`).join('\n'),
  }
}

export async function gitDiffTool({ path: rawPath } = {}) {
  requireGitEnabled()
  const repoPath = normalizeRepoPath(rawPath)
  const args = ['diff', '--no-ext-diff', '--no-color']
  if (repoPath) args.push('--', repoPath)
  const diff = await runGit(args, { rejectOnError: false })
  const statArgs = ['diff', '--stat', '--no-ext-diff', '--no-color']
  if (repoPath) statArgs.push('--', repoPath)
  const stat = await runGit(statArgs, { rejectOnError: false })
  return {
    ok: diff.ok,
    path: repoPath || null,
    stat: clip(stat.stdout || stat.stderr, 80_000),
    diff: clip(diff.stdout || diff.stderr),
    exitCode: diff.exitCode,
  }
}

export async function runProjectCheckTool({ check } = {}) {
  requireGitEnabled()
  const name = String(check || '').trim()
  if (!ALLOWED_CHECKS.has(name)) {
    throw badReq('run_project_check only supports lint, test, build')
  }
  const command = npmCommandArgs(name)
  const result = await runFile(command.file, command.args, {
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

export async function gitCommitTool({ message, files } = {}) {
  requireMutationEnabled()
  const msg = String(message || '').trim()
  if (msg.length < 3 || msg.length > 200) throw badReq('commit message must be 3-200 characters')
  const statusFiles = await currentStatusFiles()
  const selected = validateSelectedFiles(files, statusFiles)
  await runGit(['add', '--', ...selected])
  const hasStaged = await runGit(['diff', '--cached', '--quiet', '--', ...selected], { rejectOnError: false })
  if (hasStaged.exitCode === 0) throw badReq('selected files have no staged changes')
  const commit = await runGit(['commit', '-m', msg, '--', ...selected])
  const hash = await runGit(['rev-parse', 'HEAD'])
  return {
    ok: true,
    commit: hash.stdout.trim(),
    summary: commit.stdout.trim(),
    files: selected,
  }
}

export async function gitPushTool({ force = false } = {}) {
  requireMutationEnabled()
  if (force) throw badReq('force push is not allowed')
  const branch = await currentBranch()
  if (!branch || branch === 'HEAD') throw badReq('cannot push detached HEAD')
  const result = await runGit(['push', 'origin', branch], { rejectOnError: false })
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

export async function dispatchGitTool(name, args) {
  switch (name) {
    case 'git_status': return gitStatusTool(args)
    case 'git_diff': return gitDiffTool(args)
    case 'run_project_check': return runProjectCheckTool(args)
    default: throw badReq(`unknown git tool: ${name}`, 404)
  }
}

export async function handleGitWorkbenchRequest(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
  if (!authenticateRequest(req)) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
  const url = new URL(req.url || '/', 'http://localhost')
  try {
    const body = await readJson(req)
    let result
    if (url.pathname === '/api/tools/git/status' || url.pathname === '/api/workbench/git/status') result = await gitStatusTool(body)
    else if (url.pathname === '/api/tools/git/diff' || url.pathname === '/api/workbench/git/diff') result = await gitDiffTool(body)
    else if (url.pathname === '/api/tools/check/run' || url.pathname === '/api/workbench/check/run') result = await runProjectCheckTool(body)
    else if (url.pathname === '/api/workbench/git/commit') result = await gitCommitTool(body)
    else if (url.pathname === '/api/workbench/git/push') result = await gitPushTool(body)
    else return sendJson(res, 404, { ok: false, error: 'not found' })
    return sendJson(res, 200, result)
  } catch (err) {
    return sendJson(res, err?.statusCode || 500, { ok: false, error: err?.message || 'git workbench failed', result: err?.result })
  }
}

export const GIT_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Read git branch and workspace changed files. Read-only. Use before and after code edits.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Read unified git diff for the whole workspace or one changed file. Read-only.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional workspace-relative file path.' } },
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
        properties: { check: { type: 'string', enum: ['lint', 'test', 'build'] } },
        required: ['check'],
      },
    },
  },
]
