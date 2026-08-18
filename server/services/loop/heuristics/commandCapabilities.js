import {
  COMMAND_EXECUTION_TOOL_NAMES,
} from './htmlArtifactInput.js'

export function toolNameFromSpec(spec) {
  return String(spec?.function?.name || '').trim()
}

export function isCommandExecutionTool(value) {
  const name = typeof value === 'string' ? value : value?.name
  return COMMAND_EXECUTION_TOOL_NAMES.has(String(name || '').trim())
}

export function commandExecutionToolNames(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map(toolNameFromSpec)
    .filter((name) => isCommandExecutionTool(name))
}

export function hasCommandExecutionTool(specs) {
  return commandExecutionToolNames(specs).length > 0
}

export function commandExecutionToolLabel(specs) {
  return commandExecutionToolNames(specs).join(' or ') || 'bash_exec or run_command'
}
