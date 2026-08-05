/**
 * Boolean tool switches understood by the server turn runtime.
 *
 * Keep this list limited to tools that have both a server-side function spec
 * and an executor. Client-only preview executors from the retired chat loop
 * must not be sent as if the server could run them.
 */
export const SERVER_TURN_TOOL_TOGGLE_NAMES = Object.freeze([
  'web_search',
  'fetch_url',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'Agent',
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'bash_exec',
  'git_status',
  'git_diff',
  'run_project_check',
  'manage_todos',
])

const SERVER_TURN_TOOL_TOGGLE_SET = new Set(SERVER_TURN_TOOL_TOGGLE_NAMES)

export function isServerTurnToolToggle(name) {
  return SERVER_TURN_TOOL_TOGGLE_SET.has(String(name || '').trim())
}
