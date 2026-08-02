/**
 * 审批策略(approval policy)—— 纯函数,无 DB 无 IO。
 *
 * 判定「这次工具调用要不要拦下来找人批准」,以及风险等级。
 * 和 user_tool_permissions 的区别:
 *   - user_tool_permissions = 运行前、按工具名、用户自己设的静态开关
 *   - 本模块          = 运行中、按每一次调用、看具体参数定风险
 * 两者并存:先过静态开关(fsShellTools.assertToolPermitted),再过本策略。
 */
import { checkBashCommandDanger } from './bashGuard.js'

export const APPROVAL_MODES = Object.freeze(['off', 'unattended', 'all'])
export const DEFAULT_APPROVAL_MODE = 'unattended'

/**
 * 每用户的权限档位(对齐 Claude Code / Codex)。和上面的 env 级 APPROVAL_MODE 是两层:
 *   env APPROVAL_MODE  = 部署者决定「审批系统开不开、管不管交互式聊天」
 *   用户 PERMISSION_MODE = 用户决定「我现在要被问到什么程度」
 *
 *   normal      —— 默认。写操作、shell、外部写请求都要问。
 *   acceptEdits —— 改文件不问了(write/edit/apply_patch 放行),shell 和外部写请求仍然问。
 *   plan        —— 只读模式。任何写操作直接拒绝,不是「问」,是「不许」。
 *   bypass      —— 全部放行。危险,给完全信任的本机环境用。
 */
export const PERMISSION_MODES = Object.freeze(['normal', 'acceptEdits', 'plan', 'bypass'])
export const DEFAULT_PERMISSION_MODE = 'normal'

/** acceptEdits 档位下自动放行的工具:只碰文件,不执行命令、不发外部请求。 */
const EDIT_TOOLS = Object.freeze(['write_file', 'edit_file', 'apply_patch'])

// 24h。Windows CI 下任何 < 5000ms 的默认值都会 flake(见 AGENTS.md 五),这里远大于阈值。
export const DEFAULT_APPROVAL_TIMEOUT_MS = 86_400_000

const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 })

/** 需要审批的工具 → 基线风险。参数敏感度会在此基础上升级。 */
export const APPROVAL_REQUIRED_TOOLS = Object.freeze({
  // 文件系统 / shell:已有静态开关,但那是 per 工具名,这里补 per 调用
  bash_exec: 'high',
  write_file: 'medium',
  edit_file: 'medium',
  apply_patch: 'medium',
  git_commit: 'high',
  git_push: 'high',
  git_rollback: 'high',
  // 网络出站写操作
  fetch_url: 'low',
  // 浏览器自动化:能在已登录的会话里代替用户点按钮 = 可发消息/可下单
  browser_click: 'medium',
  browser_type: 'medium',
  browser_open_url: 'low',
  // 连接器:打开外部应用
  connected_app_open: 'low',
})

/** 一望即知无副作用的读类工具,永不审批(白名单优先于上表)。 */
export const NEVER_APPROVE_TOOLS = Object.freeze([
  'reflect',
  'request_clarification',
  'request_directory',
  'sleep_until',
  'manage_todos',
  'read_file',
  'list_directory',
  'grep_code',
  'find_symbol',
  'list_imports',
  'git_status',
  'git_diff',
  'web_search',
  'browser_state',
  'browser_snapshot',
  'browser_console',
  'browser_screenshot',
  'browser_wait',
  'connected_app_list',
  'notion_search',
  'notion_fetch_page',
  'github_search_repositories',
  'github_get_file',
  // 站内产物生成:只在 .artifacts/ 下落文件,不碰用户工作区、不发外部请求。
  // 这就是 job 的正常产出物,拦它等于让每个任务都卡住。
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_react_component',
  'create_mermaid',
  'create_chart',
  'create_svg',
  'create_html_app',
  'run_project_check',
])

const NEVER = new Set(NEVER_APPROVE_TOOLS)

/** 动态工具(MCP / 插件)里带这些词的按写操作处理。 */
const WRITE_INTENT_RE = /(^|_)(create|update|delete|remove|write|send|post|put|patch|publish|merge|close|comment|reply|invite|archive|move|rename|upload|execute|run|approve|pay|order|schedule)(_|$)/i

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const COMMAND_SCOPED_TOOLS = new Set(['bash_exec'])

export function normalizeCommandPrefix(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function isSafeCommandPrefix(value) {
  const raw = typeof value === 'string' ? value : ''
  return !!raw.trim() && !(/[;&|><`\r\n]|\$\(/.test(raw))
}

export function buildRememberedGrant(toolName, args = {}) {
  const name = str(toolName).trim()
  if (!name) throw new Error('toolName is required')
  if (!COMMAND_SCOPED_TOOLS.has(name)) return { toolName: name, commandPrefix: '' }
  const raw = str(args?.command)
  if (!isSafeCommandPrefix(raw)) {
    throw new Error('This shell command cannot be remembered because it contains chaining, redirection, substitution, or a newline')
  }
  return { toolName: name, commandPrefix: normalizeCommandPrefix(raw) }
}

export function matchesRememberedGrant(toolName, args = {}, grants = []) {
  const name = str(toolName).trim()
  if (!name || !Array.isArray(grants)) return false
  if (!COMMAND_SCOPED_TOOLS.has(name)) {
    return grants.some((grant) => grant?.toolName === name && !grant?.commandPrefix)
  }
  const raw = str(args?.command)
  if (!isSafeCommandPrefix(raw)) return false
  const command = normalizeCommandPrefix(raw)
  return grants.some((grant) => {
    if (grant?.toolName !== name || !isSafeCommandPrefix(grant.commandPrefix)) return false
    const prefix = normalizeCommandPrefix(grant.commandPrefix)
    return command === prefix || command.startsWith(`${prefix} `)
  })
}

function higher(a, b) {
  return RISK_ORDER[b] > RISK_ORDER[a] ? b : a
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 解析 APPROVAL_MODE。非法值回落到默认,不 throw(注入路径不 throw,见 AGENTS.md 2.5.3)。
 */
export function resolveApprovalMode(env = process.env) {
  const raw = String(env.APPROVAL_MODE || '').trim().toLowerCase()
  return APPROVAL_MODES.includes(raw) ? raw : DEFAULT_APPROVAL_MODE
}

export function resolveApprovalTimeoutMs(env = process.env) {
  const raw = Number(env.APPROVAL_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_APPROVAL_TIMEOUT_MS
  return Math.floor(raw)
}

/**
 * 这次调用要不要审批。
 *
 * @param {string} toolName
 * @param {object} [args]           工具入参
 * @param {object} [options]
 * @param {string} [options.origin] 'job' | 'subagent' | 'chat'
 * @param {string} [options.mode]   env 级审批模式,默认读 env
 * @param {string} [options.permissionMode] 用户档位 normal|acceptEdits|plan|bypass
 * @param {string[]} [options.rememberedTools] 用户点过「总是允许」的工具名
 * @returns {{ needsApproval: boolean, risk: 'low'|'medium'|'high', reason: string|null, denied?: boolean }}
 */
export function classifyToolRisk(toolName, args = {}, options = {}) {
  const name = str(toolName).trim()
  // options 显式传 null 时 default 参数不生效,这里兜一道 —— 本模块在 prompt/工具
  // 注入路径上被调用,不许 throw(AGENTS.md 2.5.3)。
  const opts = options && typeof options === 'object' ? options : {}
  const mode = opts.mode || resolveApprovalMode()
  const origin = opts.origin || 'job'
  const permissionMode = PERMISSION_MODES.includes(opts.permissionMode)
    ? opts.permissionMode
    : DEFAULT_PERMISSION_MODE
  const remembered = Array.isArray(opts.rememberedTools) ? opts.rememberedTools : []
  const rememberedGrants = Array.isArray(opts.rememberedGrants) ? opts.rememberedGrants : []
  const safeArgs = args && typeof args === 'object' ? args : {}

  if (mode === 'off') return { needsApproval: false, risk: 'low', reason: null }
  // ★ 空工具名不能当成「安全」放行 —— 那是 fail-open。
  // 归一化漏了(比如上游 wire 形状没被解开)时 name 会是空串,
  // 以前这里直接返回不需审批,等于让一个身份不明的调用绕过整个门控。
  // 身份不明 = 无法判定风险 = 必须拦。
  if (!name) {
    return {
      needsApproval: false,
      denied: true,
      risk: 'high',
      reason: '工具名为空,无法判定风险,已拒绝(这通常是上游返回格式未被正确解析)',
    }
  }
  if (NEVER.has(name)) return { needsApproval: false, risk: 'low', reason: null }

  // bypass:用户显式选了全放行
  if (permissionMode === 'bypass') return { needsApproval: false, risk: 'low', reason: null }

  // unattended 模式:交互式聊天不拦(前端已有 apply_patch 弹窗),只拦无人值守路径
  if (mode === 'unattended' && origin === 'chat') {
    return { needsApproval: false, risk: 'low', reason: null }
  }

  let risk = APPROVAL_REQUIRED_TOOLS[name]
  let reason = null

  if (!risk) {
    // 未知/动态工具(MCP、插件):名字像写操作就拦,读操作放行
    if (WRITE_INTENT_RE.test(name)) {
      risk = 'medium'
      reason = '外部工具的写操作'
    } else {
      return { needsApproval: false, risk: 'low', reason: null }
    }
  }

  // plan 档位:任何需要审批的(即有副作用的)操作一律拒绝,不是问,是不许。
  // 这样用户能安全地让模型「只看不动」地过一遍方案。
  if (permissionMode === 'plan') {
    return {
      needsApproval: false,
      denied: true,
      risk,
      reason: '当前是计划模式(只读),不执行任何写操作。要执行请切回正常模式。',
    }
  }

  // acceptEdits:改文件放行,shell / 外部写请求仍然要问
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.includes(name)) {
    return { needsApproval: false, risk, reason: null }
  }

  // 用户对这个工具点过「总是允许」
  if (name !== 'bash_exec' && remembered.includes(name)) return { needsApproval: false, risk, reason: null }
  if (matchesRememberedGrant(name, safeArgs, rememberedGrants)) {
    return { needsApproval: false, risk, reason: null }
  }

  // ── 参数敏感度加权 ──
  if (name === 'bash_exec') {
    const danger = checkBashCommandDanger(str(safeArgs.command))
    reason = danger ? `危险命令:${danger.reason}` : '执行 shell 命令'
    risk = danger ? 'high' : risk
  } else if (name === 'write_file' || name === 'edit_file') {
    const p = str(safeArgs.path)
    if (isOutsideWorkspacePath(p)) {
      risk = higher(risk, 'high')
      reason = '写入工作区之外的路径'
    } else {
      reason = reason || '修改文件'
    }
  } else if (name === 'apply_patch') {
    // dry_run 只预览不落盘,无副作用
    if (safeArgs.dry_run === true) return { needsApproval: false, risk: 'low', reason: null }
    const count = Array.isArray(safeArgs.changes) ? safeArgs.changes.length : 0
    reason = count ? `原子修改 ${count} 个文件` : '原子修改文件'
    if (count > 5) risk = higher(risk, 'high')
  } else if (name === 'fetch_url') {
    const method = str(safeArgs.method).toUpperCase() || 'GET'
    if (SAFE_HTTP_METHODS.has(method)) return { needsApproval: false, risk: 'low', reason: null }
    risk = higher(risk, 'medium')
    reason = `对外发起 ${method} 请求`
  } else if (name === 'browser_click' || name === 'browser_type') {
    reason = '在已登录的浏览器会话中代为操作'
  } else if (name === 'browser_open_url' || name === 'connected_app_open') {
    reason = '打开外部应用'
  }

  return { needsApproval: true, risk, reason }
}

/**
 * 粗判路径是否在工作区外。纯字符串判断(本模块不许碰 fs),
 * 真正的边界校验在 fsShellTools.resolveInWorkspace,这里只用于风险加权。
 */
export function isOutsideWorkspacePath(rawPath) {
  const p = str(rawPath).trim()
  if (!p) return false
  if (p.includes('..')) return true
  if (p.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true // Windows 盘符绝对路径
  if (p.startsWith('\\\\')) return true // UNC
  if (p.startsWith('~')) return true
  return false
}

/** 给 UI 用的稳定排序:高风险在前,同风险按时间。 */
export function compareRisk(a, b) {
  return (RISK_ORDER[b] ?? 0) - (RISK_ORDER[a] ?? 0)
}
