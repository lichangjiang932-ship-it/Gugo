const WORKSPACE_MUTATION_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch'])
const WORKSPACE_EXEC_TOOL_NAMES = new Set(['bash_exec'])
const GIT_WRITE_TOOL_NAMES = new Set(['git_commit', 'git_push', 'git_rollback'])
const ORCHESTRATION_TOOL_NAMES = new Set(['Agent', 'manage_todos'])

const LOCAL_PATH_GRANT_BLOCK = /\[LOCAL PATH ACCESS GRANTED\]([\s\S]*?)(?:\r?\n\r?\n|$)/i
const EXPLICIT_READ_ONLY = /\b(?:read[- ]only|no[- ]write)\b|\b(?:do not|don't|never|without)\b.{0,24}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b|只读|仅查看|仅分析|不要.{0,16}(?:修改|编辑|写入|删除|移除|重命名|移动|打补丁|改动|变更|修复)/i

function toolName(spec) {
  return String(spec?.function?.name || '')
}

function isReadOnlyRequest(prompt) {
  const text = String(prompt || '')
  const grant = LOCAL_PATH_GRANT_BLOCK.exec(text)?.[1] || ''
  return /access mode:\s*read only\.?/i.test(grant) || EXPLICIT_READ_ONLY.test(text)
}

function allowedInReadOnlyMode(name) {
  return !WORKSPACE_MUTATION_TOOL_NAMES.has(name)
    && !WORKSPACE_EXEC_TOOL_NAMES.has(name)
    && !GIT_WRITE_TOOL_NAMES.has(name)
    && !ORCHESTRATION_TOOL_NAMES.has(name)
}

/**
 * Chat routing is model-driven. A stable schema list handles indirect and
 * multilingual requests better and improves provider prompt-cache reuse.
 * This layer enforces permissions rather than guessing intent: artifact
 * authorization is applied separately, while explicit read-only requests
 * remove tools that can mutate or delegate mutations.
 */
export function selectChatToolSpecs({ prompt = '', specs = [] } = {}) {
  const readOnly = isReadOnlyRequest(prompt)
  return (Array.isArray(specs) ? specs : [])
    .filter((spec) => {
      const name = toolName(spec)
      return Boolean(name) && (!readOnly || allowedInReadOnlyMode(name))
    })
    .sort((left, right) => toolName(left).localeCompare(toolName(right), 'en'))
}
