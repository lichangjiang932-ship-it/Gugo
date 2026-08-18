import {
  getToolMetadata,
} from '../../toolRegistry.js'
import {
  isCommandExecutionTool,
} from './commandCapabilities.js'
import {
  isSuccessfulToolResult,
} from './resultStatus.js'
import {
  ENVIRONMENT_PROBE_COMMAND,
  FAILURE_RECOVERY_THRESHOLD,
  MAX_INSTALL_ATTEMPT_SIGNATURES,
  NON_REFLECTIVE_FAILURE_CODES,
  PROBE_SCRIPT_PATH,
  PROBE_SCRIPT_REFERENCE,
  TOOL_AUTHORING_FAILURE_CODES,
} from './constants.js'
import {
  inlinePythonCode,
  isLocalMutationCall,
  isMutationExecutionCall,
} from './mutationClassification.js'
import {
  hasInlinePythonMutation,
} from './pythonMutationAnalysis.js'

export {
  hasInlinePythonMutation,
} from './pythonMutationAnalysis.js'

export function restoreFailureRecovery(value = {}) {
  const attempts = Array.isArray(value?.attempts)
    ? value.attempts.slice(-FAILURE_RECOVERY_THRESHOLD).map((attempt) => ({
        tool: String(attempt?.tool || '').slice(0, 120),
        code: String(attempt?.code || 'tool_execution_failed').slice(0, 160),
        message: String(attempt?.message || 'Tool execution failed.').slice(0, 800),
      })).filter((attempt) => attempt.tool)
    : []
  return {
    tool: String(value?.tool || '').slice(0, 120),
    count: Math.max(0, Number(value?.count) || 0),
    reflected: value?.reflected === true,
    attempts,
  }
}

export function serializeFailureRecovery(value) {
  return {
    tool: value.tool,
    count: value.count,
    reflected: value.reflected,
    attempts: value.attempts,
  }
}

export function normalizeProbePath(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/')
}

export function probePathsFromCall(call) {
  const paths = []
  const add = (value) => {
    const path = normalizeProbePath(value)
    if (path) paths.push(path)
  }
  add(call?.args?.path || call?.args?.file_path || call?.args?.filePath)
  if (call?.name === 'multi_edit') {
    for (const edit of Array.isArray(call?.args?.edits) ? call.args.edits : []) {
      add(edit?.path || edit?.file_path || edit?.filePath)
    }
  }
  if (call?.name === 'apply_patch') {
    for (const match of String(call?.args?.patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
      add(match[1])
    }
  }
  return paths
}

export function installAttemptSignature(call) {
  if (!isCommandExecutionTool(call)) return ''
  const command = String(call?.args?.command || '')
  const patterns = [
    { family: 'pip', regex: /(?:^|[;&|]\s*)(?:(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+)?pip(?:3)?(?:\.exe)?\s+install\b([^;&|\r\n]*)/i },
    { family: 'npm', regex: /(?:^|[;&|]\s*)(npm|pnpm|yarn)\s+(?:install|add|i)\b([^;&|\r\n]*)/i },
  ]
  for (const { family, regex } of patterns) {
    const match = command.match(regex)
    if (!match) continue
    const manager = family === 'npm' ? String(match[1] || family).toLowerCase() : family
    const tail = String(match[family === 'npm' ? 2 : 1] || '')
    const packages = tail
      .match(/"[^"]+"|'[^']+'|[^\s]+/g)
      ?.map((token) => token.replace(/^['"]|['"]$/g, ''))
      .filter((token) => token && !token.startsWith('-') && !/^(?:true|false)$/i.test(token))
      .map((token) => token.replace(/[<>=!~].*$/, '').replace(/@(?:latest|next|\d.*)$/i, ''))
      .filter(Boolean)
      .sort() || []
    return `${manager}:${packages.join(',') || '<project>'}`
  }
  return ''
}

export function isProbeLikeCall(call) {
  if (probePathsFromCall(call).some((path) => PROBE_SCRIPT_PATH.test(path))) return true
  if (!isCommandExecutionTool(call)) return false
  // An explicit output contract or a statically visible file write is real
  // production work even when inline Python imports a library. The broad
  // environment-probe heuristic below intentionally recognizes `import`, so
  // these stronger mutation signals must win first.
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) {
    return false
  }
  const inlineCode = inlinePythonCode(call)
  if (inlineCode && hasInlinePythonMutation(inlineCode)) return false
  const command = String(call?.args?.command || '')
  return PROBE_SCRIPT_REFERENCE.test(command) || ENVIRONMENT_PROBE_COMMAND.test(command)
}

export function isExplorationOnlyCall(call, userId = null) {
  if (isProbeLikeCall(call) || installAttemptSignature(call)) return true
  return getToolMetadata(call?.name, { args: call?.args, userId }).isReadOnly === true
}

export function restoreExecutionConvergence(value = {}) {
  return {
    unproductiveRounds: Math.max(0, Number(value?.unproductiveRounds) || 0),
    interventions: Math.max(0, Number(value?.interventions) || 0),
    interventionActive: value?.interventionActive === true,
    installAttempts: Array.isArray(value?.installAttempts)
      ? [...new Set(value.installAttempts.map((item) => String(item || '').slice(0, 240)).filter(Boolean))]
          .slice(-MAX_INSTALL_ATTEMPT_SIGNATURES)
      : [],
  }
}

export function serializeExecutionConvergence(value) {
  return {
    unproductiveRounds: value.unproductiveRounds,
    interventions: value.interventions,
    interventionActive: value.interventionActive,
    installAttempts: [...value.installAttempts].slice(-MAX_INSTALL_ATTEMPT_SIGNATURES),
  }
}

export function isProductiveExecutionOutcome(call, result, artifactId = null) {
  if (!isSuccessfulToolResult(result)) return false
  if (artifactId) return true
  if (isProbeLikeCall(call) || installAttemptSignature(call)) return false
  if (!isMutationExecutionCall(call, artifactId)) return false
  if (Object.hasOwn(result || {}, 'changed')) return result.changed === true
  if (isCommandExecutionTool(call)
    && Array.isArray(call?.args?.expected_outputs)
    && Object.hasOwn(result || {}, 'changedPaths')) {
    return Array.isArray(result.changedPaths) && result.changedPaths.length > 0
  }
  return true
}

export function shouldReflectOnFailure(result) {
  if (result?.ok !== false) return false
  const code = String(result?.code || '')
  return !TOOL_AUTHORING_FAILURE_CODES.has(code)
    && !NON_REFLECTIVE_FAILURE_CODES.has(code)
    && result?.denied !== true
    && result?.cancelled !== true
}

export function progressChangesFor(call, result) {
  if (!isLocalMutationCall(call)) return { changedPaths: [], changes: [] }
  const changes = Array.isArray(result?.changes) ? result.changes : []
  const changedPaths = []
  if (result?.path) changedPaths.push(result.path)
  for (const path of Array.isArray(result?.changedPaths) ? result.changedPaths : []) {
    if (path) changedPaths.push(path)
  }
  for (const change of changes) {
    if (change?.path) changedPaths.push(change.path)
  }
  return { changedPaths, changes }
}
