import fs from 'node:fs'
import path from 'node:path'

import { projectVerificationFields } from '../utils/processExecutionFailure.js'
import { bashExecTool, resolveForShellCwd } from './fsShellTools.js'
import { assertGitToolPermitted } from './gitWorkbenchPolicy.js'

const CHECK_TIMEOUT = 5 * 60_000
const MAX_OUTPUT = 1024 * 1024
const ALLOWED_CHECKS = new Set(['lint', 'test', 'build'])

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function clip(text, max = MAX_OUTPUT) {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value
}

function availablePackageChecks(root) {
  try {
    const filename = path.join(root, 'package.json')
    const stat = fs.lstatSync(filename)
    // An optional availability read must not follow a new symlink or load an
    // unbounded manifest. Inconclusive reads retain the normal executor path.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const scripts = manifest?.scripts
    return [...ALLOWED_CHECKS].filter((name) => scripts && Object.hasOwn(scripts, name)
      && typeof scripts[name] === 'string' && scripts[name].trim())
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : null
  }
}

export async function runProjectCheckTool({
  check,
  cwd: rawCwd,
  userId = null,
  signal = null,
} = {}) {
  const name = String(check || '').trim()
  if (!ALLOWED_CHECKS.has(name)) {
    throw badRequest('run_project_check only supports lint, test, build')
  }
  assertGitToolPermitted(userId, 'run_project_check')
  const resolvedCwd = resolveForShellCwd(rawCwd, { userId })
  const root = resolvedCwd.fullPath
  if (!fs.statSync(root).isDirectory()) throw badRequest('cwd must be a directory')
  const availableChecks = availablePackageChecks(root)
  if (availableChecks && !availableChecks.includes(name)) {
    return { ok: false, code: 'PROJECT_CHECK_NOT_CONFIGURED', executed: false, check: name,
      cwd: resolvedCwd.displayPath, availableChecks, retryable: false,
      error: `The requested package check is not configured. Available checks: ${availableChecks.join(', ') || '(none)'}. Inspect the project configuration and select a provided check.` }
  }
  const command = `npm run ${name}`
  const result = await bashExecTool({
    command,
    cwd: root,
    timeout_ms: CHECK_TIMEOUT,
    expected_outputs: [],
    userId,
    signal,
  }, { permissionToolName: 'run_project_check' })
  return {
    ...result,
    ...projectVerificationFields(result),
    check: name,
    command,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
  }
}
