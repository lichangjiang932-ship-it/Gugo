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
  git_status: 'chatMessages.toolGitStatus',
  git_diff: 'chatMessages.toolGitDiff',
  run_project_check: 'chatMessages.toolRunProjectCheck',
  manage_todos: 'chatMessages.toolManageTodos',
}

export function toolCallLabel(name, t) {
  const key = TOOL_LABEL_KEYS[name]
  return key ? t(key) : (name || t('chatMessages.toolUnknown'))
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
  if (name === 'bash_exec') return String(args.command || '').replace(/\s+/g, ' ').slice(0, 96) || empty
  if (name === 'Agent') return args.subagent_type ? `${args.subagent_type}: ${(args.description || '').slice(0, 40)}` : empty
  if (name && name.startsWith('create_')) return args.title || empty
  const compact = JSON.stringify(args)
  return compact === '{}' ? t('chatMessages.toolNoArguments') : compact.slice(0, 96)
}
