export const RUNTIME_CAPABILITIES_MARKER = '[RUNTIME CAPABILITIES]'

function toolNames(specs) {
  return new Set((Array.isArray(specs) ? specs : [])
    .map((spec) => String(spec?.function?.name || '').trim())
    .filter(Boolean))
}

function hasAny(names, values) {
  return values.some((name) => names.has(name))
}

function add(lines, condition, text) {
  if (condition) lines.push(text)
}

/**
 * Build a short, truthful capability guide from the exact tool set exposed to
 * this model turn. This intentionally does not maintain another tool catalog.
 */
export function buildRuntimeCapabilityBlock({
  toolSpecs = [],
  approvalMode = null,
  defaultOutputDirectory = '',
  projectDirectory = '',
} = {}) {
  const names = toolNames(toolSpecs)
  const lines = [
    RUNTIME_CAPABILITIES_MARKER,
    'Only capabilities backed by tools in this turn are listed below. Use the tools instead of claiming the capability is unavailable.',
    'Before saying that a tool or capability is missing, inspect the exact tool schemas supplied with this request and the capability list below. Calling only read tools is not evidence that write tools are absent.',
    'If the user challenges a prior claim that you cannot make an unfinished change, re-check this turn\'s schemas and continue the change when the required tools are present. Do not repeat the prior capability claim from memory.',
    'When the user asks for a concrete change or deliverable and a relevant tool is exposed, call the tool now. Do not substitute copy-paste code, shell commands, or manual instructions for execution.',
    'If a tool fails, use its code, error, and hint to diagnose the cause, change the arguments or inspect state with another exposed tool, and continue. Do not repeat the identical failed call; ask the user only for a real permission, approval, or indispensable input blocker.',
    'Before claiming completion, verify changed or generated outputs with an exposed read, inspect, probe, diff, or check tool.',
  ]

  add(lines, hasAny(names, ['list_directory', 'read_file']),
    '- Files: inspect authorized workspace/local files with list_directory and read_file.')
  add(lines, hasAny(names, ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'multi_edit']),
    '- File changes: create or edit authorized local files, then verify the result by reading or checking it.')
  add(lines, hasAny(names, ['bash_exec', 'run_command', 'run_test', 'docker_exec']),
    '- Code and automation: run shell commands for builds, tests, scripts, and specialized local tooling; declare expected output files.')
  add(lines, hasAny(names, ['git_status', 'git_diff', 'git_commit', 'git_push', 'git_rollback', 'git_write']),
    '- Git: inspect repository state and use only the exact Git mutation tools that are exposed.')
  add(lines, names.has('media_probe') || names.has('media_transform'),
    '- Audio/video: inspect media with media_probe and use media_transform for trim, transcode, audio extraction, speed changes, GIF generation, subtitle burn-in, concatenation, volume adjustment, or audio denoising. These tools accept large files by path.')
  add(lines, hasAny(names, ['pdf_info', 'pdf_text', 'pdf_transform', 'render_pdf_pages']),
    '- PDF: inspect page/form metadata with pdf_info, extract page text and positioned text items with pdf_text, use pdf_transform for structural edits, and use render_pdf_pages for deterministic PDF-to-image conversion. Never use generate_image to reproduce an existing PDF page. Verify the produced PDF or rendered pages visually.')
  add(lines, names.has('image_info') || names.has('image_transform') || names.has('render_pdf_pages'),
    '- Images: inspect metadata with image_info and use image_transform for conversion, resize, crop, rotation, and filters, including large files by path.')
  add(lines, hasAny(names, ['archive_list', 'archive_create', 'archive_extract', 'batch_rename', 'file_hash_manifest']),
    '- Batch files: inspect ZIP contents without extraction, create/extract ZIP archives, perform staged bulk file or directory renames, and build SHA-256 duplicate manifests with the exposed batch file tools.')
  add(lines, hasAny(names, ['create_pptx', 'create_docx', 'create_xlsx', 'create_pdf', 'create_html_app', 'generate_image', 'render_pdf_pages']),
    '- Artifacts: use the exposed create_*, generate_image, or render_pdf_pages tool only when the user requested that deliverable. Existing files are inputs to the matching deterministic file tool; generate_image is only for a genuinely new AI-created image.')
  add(lines, hasAny(names, ['web_search', 'fetch_url']),
    '- Web: search or fetch current public information when those tools are exposed.')
  add(lines, names.has('file_download'),
    '- Downloads: stream public HTTP/HTTPS binary files into authorized local paths with size and optional SHA-256 verification.')
  add(lines, [...names].some((name) => name.startsWith('browser_')),
    '- Browser: use browser_navigate, then browser_snapshot, then browser_click/browser_type/browser_select/browser_press. Take a fresh snapshot after navigation or major DOM changes because element refs can become stale; use screenshots for visual evidence.')
  add(lines, [...names].some((name) => name.startsWith('mcp__')),
    '- MCP: connected MCP tools are callable by their exact exposed names.')
  add(lines, [...names].some((name) => /^(?:connected_app_|notion_|github_|google_|slack_|jira_|linear_|mail_)/u.test(name)),
    '- Connected apps: use only the exposed connector tools and respect approval before external writes.')
  add(lines, names.has('Agent'),
    '- Delegation: use Agent for independent, bounded subtasks that benefit from parallel work.')
  add(lines, names.has('manage_todos'),
    '- Planning: keep multi-step execution visible with manage_todos and update statuses as work progresses.')
  add(lines, names.has('request_directory') && approvalMode !== 'bypass',
    '- Authorization: if a required local path is not authorized, call request_directory with the needed read or read/write access instead of asking the user to edit environment files.')

  if (defaultOutputDirectory) {
    lines.push(
      `- Default generated-file directory: ${String(defaultOutputDirectory)}. When the user does not specify a destination, create the new file there. An explicit user path always wins, and revisions must modify the original file in place.`,
    )
  }
  if (projectDirectory) {
    lines.push(`- Current project directory: ${String(projectDirectory)}. Resolve explicit relative project paths against this directory.`)
  }
  if (approvalMode === 'bypass') {
    lines.push('- Approval mode: bypass (allow all). Local file, directory, shell, and Git operations do not require an authorization prompt; continue with the tools directly.')
  } else if (approvalMode) {
    lines.push(`- Approval mode: ${String(approvalMode)}. Request authorization only when the runtime reports a real permission blocker.`)
  }
  return lines.join('\n').slice(0, 6_000)
}

export function replaceRuntimeCapabilityBlock(messages, options = {}) {
  const filtered = (Array.isArray(messages) ? messages : []).filter((message) => !(
    message?.role === 'system'
      && String(message?.content || '').includes(RUNTIME_CAPABILITIES_MARKER)
  ))
  const block = buildRuntimeCapabilityBlock(options)
  if (block) {
    let insertAt = 0
    while (filtered[insertAt]?.role === 'system') insertAt += 1
    filtered.splice(insertAt, 0, { role: 'system', content: block })
  }
  return filtered
}
