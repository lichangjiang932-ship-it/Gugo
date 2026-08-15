/**
 * Boolean tool switches understood by the server turn runtime.
 *
 * Keep this list limited to tools that have both a server-side function spec
 * and an executor. Client-only preview executors from the retired chat loop
 * must not be sent as if the server could run them.
 */
export const SERVER_TURN_TOOL_TOGGLE_NAMES = Object.freeze([
  'fetch_url',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_pdf',
  'Agent',
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
  'run_test',
  'docker_exec',
  'file_download',
  'git_status',
  'git_diff',
  'git_commit',
  'git_push',
  'git_rollback',
  'git_write',
  'run_project_check',
  'image_info',
  'image_transform',
  'media_probe',
  'media_transform',
  'pdf_info',
  'pdf_text',
  'pdf_transform',
  'archive_list',
  'archive_create',
  'archive_extract',
  'batch_rename',
  'file_hash_manifest',
  'manage_todos',
])

const SERVER_TURN_TOOL_TOGGLE_SET = new Set(SERVER_TURN_TOOL_TOGGLE_NAMES)

export function isServerTurnToolToggle(name) {
  return SERVER_TURN_TOOL_TOGGLE_SET.has(String(name || '').trim())
}
