/**
 * 工具调用展示文案的单一来源。
 *
 * ToolCallCard(卡片详情) 和 ActivityStream(实时交错文本流) 都要把一次工具调用
 * 翻译成「人话」：标签（toolWebSearch → "网页搜索"）+ 参数摘要（read_file → 路径）。
 * 以前这两段逻辑只写在 ToolCallCard 里，实时文本流要复用就得复制一份。
 * 现在收敛到这里，两个消费方共用，避免文案漂移。
 *
 * 纯展示逻辑：无副作用、无 IO，符合 lib/ 约定。
 */

export const TOOL_LABEL_KEYS = {
  web_search: 'chatMessages.toolWebSearch',
  fetch_url: 'chatMessages.toolFetchUrl',
  create_pptx: 'chatMessages.toolCreatePptx',
  create_docx: 'chatMessages.toolCreateDocx',
  create_xlsx: 'chatMessages.toolCreateXlsx',
  create_react_component: 'chatMessages.toolCreateReactComponent',
  create_mermaid: 'chatMessages.toolCreateMermaid',
  create_chart: 'chatMessages.toolCreateChart',
  create_svg: 'chatMessages.toolCreateSvg',
  create_html_app: 'chatMessages.toolCreateHtmlApp',
  Agent: 'chatMessages.toolAgent',
  read_file: 'chatMessages.toolReadFile',
  write_file: 'chatMessages.toolWriteFile',
  edit_file: 'chatMessages.toolEditFile',
  multi_edit: 'chatMessages.toolMultiEdit',
  apply_patch: 'chatMessages.toolApplyPatch',
  list_directory: 'chatMessages.toolListDirectory',
  grep_code: 'chatMessages.toolGrepCode',
  find_symbol: 'chatMessages.toolFindSymbol',
  bash_exec: 'chatMessages.toolBashExec',
  run_command: 'chatMessages.toolBashExec',
  run_test: 'chatMessages.toolRunTest',
  docker_exec: 'chatMessages.toolDockerExec',
  bash_background: 'chatMessages.toolBackgroundCommand',
  process_list: 'chatMessages.toolProcessList',
  process_kill: 'chatMessages.toolProcessKill',
  git_status: 'chatMessages.toolGitStatus',
  git_diff: 'chatMessages.toolGitDiff',
  run_project_check: 'chatMessages.toolRunProjectCheck',
  manage_todos: 'chatMessages.toolManageTodos',
  request_directory: 'chatMessages.toolRequestDirectory',
  request_clarification: 'chatMessages.toolRequestClarification',
  set_deliverables: 'chatMessages.toolSetDeliverables',
  rewind_files: 'chatMessages.toolRewindFiles',
  list_imports: 'chatMessages.toolListImports',
  reflect: 'chatMessages.toolReflect',
}

export function toolCallLabel(name, t) {
  const key = TOOL_LABEL_KEYS[name]
  return key ? t(key) : (name || t('chatMessages.toolUnknown'))
}

// ★ 执行过程(工具卡片 / 活动流 / 进度条)按用户要求用全英文技术标签,
// 与界面语言无关 —— 执行轨迹属于技术事实,不随 UI 语言翻译。
export const TOOL_LABELS_EN = {
  web_search: 'Web search',
  fetch_url: 'Fetch URL',
  create_pptx: 'Create PowerPoint',
  create_docx: 'Create Word',
  create_xlsx: 'Create Excel',
  create_react_component: 'Create React component',
  create_mermaid: 'Create diagram',
  create_chart: 'Create chart',
  create_svg: 'Create SVG',
  create_html_app: 'Create HTML app',
  Agent: 'Subagent',
  read_file: 'Read file',
  write_file: 'Write file',
  edit_file: 'Edit file',
  multi_edit: 'Multi edit',
  apply_patch: 'Apply patch',
  list_directory: 'List directory',
  grep_code: 'Search code',
  find_symbol: 'Find symbol',
  bash_exec: 'Run command',
  run_command: 'Run command',
  run_test: 'Run tests',
  docker_exec: 'Docker exec',
  bash_background: 'Background command',
  process_list: 'List processes',
  process_kill: 'Kill process',
  git_status: 'Git status',
  git_diff: 'Git diff',
  run_project_check: 'Run project check',
  manage_todos: 'Update todos',
  request_directory: 'Request directory',
  request_clarification: 'Ask for clarification',
  set_deliverables: 'Set deliverables',
  rewind_files: 'Rewind files',
  list_imports: 'List imports',
  reflect: 'Reflect',
}

export function toolCallLabelEn(name) {
  return TOOL_LABELS_EN[name] || name || 'Tool'
}

/** 执行过程专用的英文参数摘要(与 summarizeToolArgs 同结构,不依赖 i18n)。 */
export function summarizeToolArgsEn(name, args) {
  const empty = '(empty)'
  if (name === 'web_search') return args.query || empty
  if (name === 'fetch_url') return args.url || empty
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return args.path || empty
  if (name === 'list_directory') return args.path || '(current workspace)'
  if (name === 'grep_code') return args.pattern || '(not specified)'
  if (name === 'find_symbol') return args.name || '(not specified)'
  if (name === 'multi_edit') return `${(args.edits || []).length} edits`
  if (name === 'apply_patch') return `${String(args.patch || '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length || 0} files`
  if (['bash_exec', 'run_command', 'run_test', 'docker_exec', 'bash_background'].includes(name)) {
    const command = Array.isArray(args.command) ? args.command.join(' ') : args.command
    return String(command || '').replace(/\s+/g, ' ').slice(0, 110) || empty
  }
  if (name === 'manage_todos') {
    const todos = Array.isArray(args.todos) ? args.todos : []
    const current = todos.find((todo) => todo?.status === 'in_progress') || todos.find((todo) => todo?.content || todo?.activeForm)
    return String(current?.activeForm || current?.content || `${todos.length} todos`).slice(0, 110)
  }
  if (name === 'request_directory') return String(args.path || args.suggested_path || args.suggestedPath || args.purpose || empty).slice(0, 110)
  if (name === 'request_clarification') return String(args.question || args.prompt || empty).slice(0, 110)
  if (name === 'set_deliverables') {
    const ids = Array.isArray(args.artifact_ids) ? args.artifact_ids : []
    return ids.length === 1 ? '1 final file' : `${ids.length} final files`
  }
  if (name === 'process_kill') return String(args.processId || args.process_id || empty)
  if (name === 'process_list') return args.processId || args.process_id || 'Background processes'
  if (name === 'rewind_files') return String(args.checkpointId || args.checkpoint_id || args.reason || empty).slice(0, 110)
  if (name === 'list_imports') return String(args.path || empty).slice(0, 110)
  if (name === 'reflect') return String(args.summary || args.observation || args.reason || 'Reviewing progress').slice(0, 110)
  if (name === 'Agent') return args.subagent_type ? `${args.subagent_type}: ${(args.description || '').slice(0, 40)}` : empty
  if (name && name.startsWith('create_')) return args.title || empty
  const commonValue = ['path', 'url', 'query', 'pattern', 'name', 'title', 'description', 'prompt', 'question', 'filename']
    .map((key) => args[key])
    .find((value) => typeof value === 'string' && value.trim())
  return commonValue ? String(commonValue).replace(/\s+/g, ' ').slice(0, 110) : '(no arguments)'
}

export function parseToolArgs(argsJson) {
  if (argsJson && typeof argsJson === 'object' && !Array.isArray(argsJson)) return argsJson
  try {
    const parsed = JSON.parse(argsJson || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function summarizeToolArgs(name, args, t) {
  const empty = t('chatMessages.toolEmptyValue')
  if (name === 'web_search') return args.query || empty
  if (name === 'fetch_url') return args.url || empty
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return args.path || empty
  if (name === 'list_directory') return args.path || t('chatMessages.toolCurrentWorkspace')
  if (name === 'grep_code') return args.pattern || t('chatMessages.toolUnspecified')
  if (name === 'find_symbol') return args.name || t('chatMessages.toolUnspecified')
  if (name === 'multi_edit') return t('chatMessages.toolEditCount', { count: (args.edits || []).length })
  if (name === 'apply_patch') return t('chatMessages.toolFileCount', { count: String(args.patch || '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length || 0 })
  if (['bash_exec', 'run_command', 'run_test', 'docker_exec', 'bash_background'].includes(name)) {
    const command = Array.isArray(args.command) ? args.command.join(' ') : args.command
    return String(command || '').replace(/\s+/g, ' ').slice(0, 110) || empty
  }
  if (name === 'manage_todos') {
    const todos = Array.isArray(args.todos) ? args.todos : []
    const current = todos.find((todo) => todo?.status === 'in_progress') || todos.find((todo) => todo?.content || todo?.activeForm)
    return String(current?.activeForm || current?.content || t('chatMessages.toolTodoCount', { count: todos.length })).slice(0, 110)
  }
  if (name === 'request_directory') return String(args.path || args.suggested_path || args.suggestedPath || args.purpose || empty).slice(0, 110)
  if (name === 'request_clarification') return String(args.question || args.prompt || empty).slice(0, 110)
  if (name === 'set_deliverables') {
    const ids = Array.isArray(args.artifact_ids) ? args.artifact_ids : []
    return t('chatMessages.toolDeliverableCount', { count: ids.length })
  }
  if (name === 'process_kill') return String(args.processId || args.process_id || empty)
  if (name === 'process_list') return args.processId || args.process_id || t('chatMessages.toolBackgroundProcesses')
  if (name === 'rewind_files') return String(args.checkpointId || args.checkpoint_id || args.reason || empty).slice(0, 110)
  if (name === 'list_imports') return String(args.path || empty).slice(0, 110)
  if (name === 'reflect') return String(args.summary || args.observation || args.reason || t('chatMessages.toolReviewingProgress')).slice(0, 110)
  if (name === 'Agent') return args.subagent_type ? `${args.subagent_type}: ${(args.description || '').slice(0, 40)}` : empty
  if (name && name.startsWith('create_')) return args.title || empty
  const commonValue = ['path', 'url', 'query', 'pattern', 'name', 'title', 'description', 'prompt', 'question', 'filename']
    .map((key) => args[key])
    .find((value) => typeof value === 'string' && value.trim())
  return commonValue ? String(commonValue).replace(/\s+/g, ' ').slice(0, 110) : t('chatMessages.toolNoArguments')
}
