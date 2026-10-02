import { dispatchCodingAgentTool } from '../adapters/codingAgentTools.js'
import { dispatchFsShellTool } from '../adapters/fsShellTools.js'
import { dispatchGitHistoryTool, isGitHistoryTool } from '../adapters/gitHistoryTools.js'
import { dispatchGitTool } from '../adapters/gitWorkbench.js'

const FILE_AND_SHELL_TOOLS = new Set([
  'read_file', 'list_directory', 'write_file', 'edit_file', 'bash_exec',
])
const CODING_TOOLS = new Set(['run_command', 'run_test'])
const PROJECT_TOOLS = new Set(['run_project_check', 'git_status', 'git_diff'])

/** Dispatch the general subagent's canonical inspect/change/verify tools. */
export function dispatchSubagentExecutionTool(toolName, args, context = {}) {
  const {
    userId = null, signal = null, toolCallId = null, idempotencyKey = null,
    idempotentResume = false, sideEffectRecoveryPlan = null,
  } = context
  if (FILE_AND_SHELL_TOOLS.has(toolName)) {
    return dispatchFsShellTool(toolName, args, {
      userId, signal, toolCallId, idempotencyKey, idempotentResume, sideEffectRecoveryPlan,
    })
  }
  if (CODING_TOOLS.has(toolName)) {
    return dispatchCodingAgentTool(toolName, args, { userId, signal, toolCallId, idempotencyKey })
  }
  if (PROJECT_TOOLS.has(toolName)) {
    return dispatchGitTool(toolName, args, { userId, signal, toolCallId, idempotencyKey })
  }
  // git_log / git_blame have their own adapter: the workbench's dispatchGitTool
  // has no branch for them and would throw "unknown git tool".
  if (isGitHistoryTool(toolName)) {
    return Promise.resolve()
      .then(() => dispatchGitHistoryTool(toolName, args || {}, { userId, cwd: args?.cwd }))
      .catch((error) => ({ ok: false, error: error?.message || String(error) }))
  }
  return undefined
}
