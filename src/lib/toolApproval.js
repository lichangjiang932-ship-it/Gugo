/**
 * 前端工具调用的审批闸口 —— 对齐 Claude Code / Codex 的「对话里问一句」。
 *
 * 以前只有 apply_patch 有确认弹窗,而且:
 *   - 只能「批准 / 拒绝」,没有「总是允许」,同一个工具第 N 次还在问
 *   - localStorage 的 apply_patch.auto_approve 是个后门,一开全放行
 *   - 其他有副作用的工具(bash_exec / write_file / 浏览器代操作)完全没门控
 *
 * 现在所有前端工具调用都过这里,决策就在对话里做,不用切页面。
 */

// 与服务端 approvalPolicy.js 保持一致的口径。这里是「前端先拦一道」,
// 服务端仍会独立判定 —— 前端可被绕过,不能当安全边界。
const APPROVAL_REQUIRED = {
  bash_exec: 'high',
  write_file: 'medium',
  edit_file: 'medium',
  apply_patch: 'medium',
  browser_click: 'medium',
  browser_type: 'medium',
  browser_open_url: 'low',
  connected_app_open: 'low',
}

const WRITE_INTENT_RE = /(^|_)(create|update|delete|remove|write|send|post|put|patch|publish|merge|close|comment|reply|invite|archive|move|rename|upload|execute|run|approve|pay|order|schedule)(_|$)/i

const NEVER_APPROVE = new Set([
  'reflect', 'request_clarification', 'manage_todos', 'read_file', 'list_directory',
  'grep_code', 'find_symbol', 'list_imports', 'git_status', 'git_diff', 'web_search',
  'browser_state', 'browser_snapshot', 'browser_console', 'browser_screenshot',
  'browser_close', 'browser_wait', 'connected_app_list', 'notion_search',
  'notion_fetch_page', 'github_search_repositories', 'github_get_file',
  'create_pptx', 'create_docx', 'create_xlsx', 'create_react_component',
  'create_mermaid', 'create_chart', 'create_svg', 'create_html_app', 'run_project_check',
])

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])
const SAFE_HTTP = new Set(['GET', 'HEAD', 'OPTIONS'])

function isOutsideWorkspace(p) {
  const s = String(p || '').trim()
  if (!s) return false
  return s.includes('..') || s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('~')
}

/**
 * 判断这次调用要不要在对话里问用户。
 * @returns {{ needsApproval:boolean, denied?:boolean, risk:string, reason:string|null }}
 */
export function classifyClientTool(name, args = {}, { mode = 'normal', rememberedTools = [] } = {}) {
  const tool = String(name || '').trim()
  const safeArgs = args && typeof args === 'object' ? args : {}
  // ★ 空工具名不能当成安全放行(fail-open)。身份不明 = 无法判定风险 = 拒绝。
  if (!tool) {
    return { needsApproval: false, denied: true, risk: 'high', reason: '工具名为空,无法判定风险,已拒绝' }
  }
  if (NEVER_APPROVE.has(tool)) return { needsApproval: false, risk: 'low', reason: null }
  if (mode === 'bypass') return { needsApproval: false, risk: 'low', reason: null }

  let risk = APPROVAL_REQUIRED[tool]
  let reason = null
  if (!risk) {
    if (WRITE_INTENT_RE.test(tool)) { risk = 'medium'; reason = '外部工具的写操作' }
    else return { needsApproval: false, risk: 'low', reason: null }
  }

  // 计划模式:只读,写操作直接拒,不问
  if (mode === 'plan') {
    return { needsApproval: false, denied: true, risk, reason: '当前是计划模式(只读),不执行写操作。' }
  }
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(tool)) return { needsApproval: false, risk, reason: null }
  if (Array.isArray(rememberedTools) && rememberedTools.includes(tool)) {
    return { needsApproval: false, risk, reason: null }
  }

  // 参数敏感度
  if (tool === 'bash_exec') {
    reason = '执行 shell 命令'
    risk = 'high'
  } else if (tool === 'write_file' || tool === 'edit_file') {
    if (isOutsideWorkspace(safeArgs.path)) { risk = 'high'; reason = '写入工作区之外的路径' }
    else reason = '修改文件'
  } else if (tool === 'apply_patch') {
    if (safeArgs.dry_run === true) return { needsApproval: false, risk: 'low', reason: null }
    const n = Array.isArray(safeArgs.changes) ? safeArgs.changes.length : 0
    reason = n ? `原子修改 ${n} 个文件` : '原子修改文件'
    if (n > 5) risk = 'high'
  } else if (tool === 'fetch_url') {
    const m = String(safeArgs.method || 'GET').toUpperCase()
    if (SAFE_HTTP.has(m)) return { needsApproval: false, risk: 'low', reason: null }
    reason = `对外发起 ${m} 请求`
  } else if (tool === 'browser_click' || tool === 'browser_type') {
    reason = '在已登录的浏览器会话中代为操作'
  }

  return { needsApproval: true, risk, reason }
}

/**
 * 请求用户在对话里做决定。ChatSplit 挂上 window.__toolApprovalGate 提供 UI。
 * 没有 UI 时(比如非聊天上下文)保守拒绝,不静默放行。
 *
 * @returns {Promise<{approved:boolean, remember?:boolean, reason?:string}>}
 */
export async function askToolApproval({ name, args, risk, reason, preview }) {
  if (typeof window === 'undefined' || typeof window.__toolApprovalGate !== 'function') {
    return { approved: false, reason: '没有可用的审批界面,已保守拒绝' }
  }
  try {
    const res = await window.__toolApprovalGate({ name, args, risk, reason, preview })
    if (typeof res === 'boolean') return { approved: res }
    return { approved: !!res?.approved, remember: !!res?.remember }
  } catch {
    return { approved: false, reason: '审批界面异常,已保守拒绝' }
  }
}
