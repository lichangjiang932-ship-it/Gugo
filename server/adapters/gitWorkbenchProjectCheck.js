import fs from 'node:fs'

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
