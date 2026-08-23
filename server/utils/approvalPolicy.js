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
import { createHash } from 'node:crypto'
import { CONNECTOR_WRITE_TOOL_SET } from '../../shared/connectorWriteTools.js'
import { findMatchingTaskGrant } from './taskGrants.js'

export const APPROVAL_MODES = Object.freeze(['off', 'unattended', 'all'])
export const DEFAULT_APPROVAL_MODE = 'unattended'

/**
 * 每用户的权限档位(对齐 Claude Code / Codex)。和上面的 env 级 APPROVAL_MODE 是两层:
 *   env APPROVAL_MODE  = 部署者决定审批队列是否可用；不会覆盖用户档位的安全边界
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
const EDIT_TOOLS = Object.freeze([
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'image_transform',
  'pdf_transform',
  'archive_create',
  'archive_extract',
  'batch_rename',
])

// 24h。Windows CI 下任何 < 5000ms 的默认值都会 flake(见 AGENTS.md 五),这里远大于阈值。
export const DEFAULT_APPROVAL_TIMEOUT_MS = 86_400_000

const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2 })

/** 需要审批的工具 → 基线风险。参数敏感度会在此基础上升级。 */
export const APPROVAL_REQUIRED_TOOLS = Object.freeze({
  // 文件系统 / shell:已有静态开关,但那是 per 工具名,这里补 per 调用
  bash_exec: 'high',
  run_command: 'high',
  run_project_check: 'high',
  run_test: 'high',
  docker_exec: 'high',
  bash_background: 'high',
  process_kill: 'high',
  write_file: 'medium',
  edit_file: 'medium',
  apply_patch: 'medium',
  patch_file: 'medium',
  file_download: 'medium',
  image_transform: 'medium',
  pdf_transform: 'medium',
  media_transform: 'high',
  archive_create: 'medium',
  archive_extract: 'medium',
  batch_rename: 'medium',
  git_commit: 'high',
  git_push: 'high',
  git_rollback: 'high',
  git_write: 'high',
  rewind_files: 'high',
  // 网络出站写操作
  fetch_url: 'low',
  // 浏览器自动化:能在已登录的会话里代替用户点按钮 = 可发消息/可下单
  browser_click: 'medium',
  browser_type: 'medium',
  browser_select: 'medium',
  browser_press: 'medium',
  browser_open_url: 'low',
  browser_navigate: 'low',
  // 连接器:打开外部应用
  connected_app_open: 'low',
  qq_mail_send: 'medium',
})

// Sending mail is an irreversible external side effect. Keep it as a
// per-call decision unless the user explicitly selects bypass.
const ALWAYS_CONFIRM_TOOLS = CONNECTOR_WRITE_TOOL_SET

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
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
  'file_hash_manifest',
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
  'create_pdf',
  'create_html_app',
  'render_pdf_pages',
])

const NEVER = new Set(NEVER_APPROVE_TOOLS)

// Plan mode exposes only local, side-effect-free inspection tools to the
// model. Network/connector/dynamic tools fail closed even when they describe
// themselves as read-only. The same allowlist is also enforced at execution.
const PLAN_LOCAL_READ_TOOLS = new Set([
  'reflect',
  'request_clarification',
  'request_directory',
  'manage_todos',
  'read_artifact_source',
  'list_directory',
  'read_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'git_status',
  'git_diff',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
  'file_hash_manifest',
  'process_list',
])

export function isToolVisibleInPermissionMode(toolName, permissionMode = DEFAULT_PERMISSION_MODE) {
  const name = str(toolName).trim()
  if (!name) return false
  const mode = PERMISSION_MODES.includes(permissionMode)
    ? permissionMode
    : DEFAULT_PERMISSION_MODE
  return mode !== 'plan' || PLAN_LOCAL_READ_TOOLS.has(name)
}

/** 动态工具(MCP / 插件)里带这些词的按写操作处理。 */
const WRITE_INTENT_RE = /(^|_)(create|update|delete|remove|write|send|post|put|patch|publish|merge|close|comment|reply|invite|archive|move|rename|upload|execute|run|approve|pay|order|schedule)(_|$)/i

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SHELL_TOOLS = new Set(['bash_exec', 'run_command', 'run_project_check', 'run_test', 'docker_exec'])
const TARGET_KEYS = Object.freeze([
  'to', 'recipient', 'recipientEmail', 'email', 'channelId', 'channel', 'conversationId',
  'repository', 'repo', 'owner', 'url', 'path', 'target', 'resourceId', 'id',
])

export function normalizeCommandPrefix(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function isSafeCommandPrefix(value) {
  const raw = typeof value === 'string' ? value : ''
  return !!raw.trim() && !(/[;&|><`\r\n]|\$\(/.test(raw))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function normalizedTarget(args = {}) {
  const safeArgs = args && typeof args === 'object' ? args : {}
  const patchPaths = Array.isArray(safeArgs.changes)
    ? safeArgs.changes.map((change) => str(change?.path).trim()).filter(Boolean).sort()
    : []
  if (patchPaths.length) return `target:paths=${patchPaths.join('|')}`
  for (const key of TARGET_KEYS) {
    const value = safeArgs[key]
    if (typeof value === 'string' && value.trim()) return `target:${key}=${value.trim()}`
    if (typeof value === 'number' && Number.isFinite(value)) return `target:${key}=${value}`
  }
  const fingerprint = createHash('sha256').update(stableJson(safeArgs)).digest('hex').slice(0, 24)
  return `args:${fingerprint}`
}

export function buildRememberedGrant(toolName, args = {}) {
  const name = str(toolName).trim()
  if (!name) throw new Error('toolName is required')
  if (SHELL_TOOLS.has(name)) throw new Error('Shell tools cannot be remembered; approve each execution explicitly')
  return { toolName: name, commandPrefix: normalizedTarget(args) }
}

export function matchesRememberedGrant(toolName, args = {}, grants = []) {
  return !!findRememberedGrant(toolName, args, grants)
}

export function findRememberedGrant(toolName, args = {}, grants = []) {
  const name = str(toolName).trim()
  if (!name || !Array.isArray(grants)) return null
  if (SHELL_TOOLS.has(name)) return null
  const expected = buildRememberedGrant(name, args).commandPrefix
  return grants.find((grant) => grant?.toolName === name && grant?.commandPrefix === expected) || null
}

function higher(a, b) {
  return RISK_ORDER[b] > RISK_ORDER[a] ? b : a
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function explicitConfirmationReason(toolName, args = {}) {
  if (toolName !== 'pdf_transform') return null
  const operation = str(args.operation).trim().toLowerCase()
  if (operation === 'fill_form') return '填写 PDF 表单可能写入错误或敏感内容'
  if (operation === 'overlay_text') return '覆盖 PDF 原文区域可能遮盖既有内容'
  return null
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
 * @param {object[]} [options.taskGrants] 当前持久化任务的精确目标授权
 * @param {object[]} [options.rememberedGrants] 参数范围化的常驻授权规则
 * @returns {{ needsApproval: boolean, risk: 'low'|'medium'|'high', reason: string|null, denied?: boolean }}
 */
export function classifyToolRisk(toolName, args = {}, options = {}) {
  const name = str(toolName).trim()
  // options 显式传 null 时 default 参数不生效,这里兜一道 —— 本模块在 prompt/工具
  // 注入路径上被调用,不许 throw(AGENTS.md 2.5.3)。
  const opts = options && typeof options === 'object' ? options : {}
  const mode = APPROVAL_MODES.includes(opts.mode) ? opts.mode : resolveApprovalMode()
  const permissionMode = PERMISSION_MODES.includes(opts.permissionMode)
    ? opts.permissionMode
    : DEFAULT_PERMISSION_MODE
  const rememberedGrants = Array.isArray(opts.rememberedGrants) ? opts.rememberedGrants : []
  const taskGrants = Array.isArray(opts.taskGrants) ? opts.taskGrants : []
  const safeArgs = args && typeof args === 'object' ? args : {}
  const metadata = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : null
  const parameterConfirmationReason = explicitConfirmationReason(name, safeArgs)
  const alwaysConfirm = ALWAYS_CONFIRM_TOOLS.has(name) || !!parameterConfirmationReason

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

  // Plan mode is deliberately stricter than the generic NEVER_APPROVE list
  // because some entries there create artifacts or contact the network
  // without prompting. Schema projection uses this same allowlist, while this
  // execution check remains authoritative for stale or forged calls.
  if (permissionMode === 'plan') {
    // Production callers provide authoritative registry metadata. A dynamic
    // capability must not inherit plan privileges merely by reusing a builtin
    // read-only name such as read_file. The no-metadata case remains supported
    // for the small pure-policy API used by legacy callers and unit tests.
    if (PLAN_LOCAL_READ_TOOLS.has(name)
      && (!metadata || metadata.origin === 'builtin')) {
      return { needsApproval: false, risk: 'low', reason: null }
    }
    return {
      needsApproval: false,
      denied: true,
      risk: APPROVAL_REQUIRED_TOOLS[name] || 'medium',
      reason: '当前是计划模式（仅限工作区只读）。该工具仍已加载，但写入、命令、网络和外部工具被策略禁止执行。请切换到自动接受编辑模式或正常模式后继续。',
    }
  }
  if (NEVER.has(name)) return { needsApproval: false, risk: 'low', reason: null }

  let risk = APPROVAL_REQUIRED_TOOLS[name] || (alwaysConfirm ? 'medium' : undefined)
  let reason = parameterConfirmationReason || (alwaysConfirm ? '\u5916\u90e8\u5de5\u5177\u7684\u5199\u64cd\u4f5c' : null)

  // 明确的无副作用参数优先于工具级风险。plan 模式也可以安全预览/读取。
  if ((name === 'apply_patch' || name === 'patch_file') && safeArgs.dry_run === true) {
    return { needsApproval: false, risk: 'low', reason: null }
  }
  if (name === 'fetch_url') {
    const method = str(safeArgs.method).toUpperCase() || 'GET'
    if (SAFE_HTTP_METHODS.has(method)) return { needsApproval: false, risk: 'low', reason: null }
  }

  if (metadata) {
    if (!alwaysConfirm && (metadata.requiresApproval === false || metadata.riskClass === 'read')) {
      return { needsApproval: false, risk: 'low', reason: null }
    }
    risk = metadata.riskClass === 'exec' ? 'high' : 'medium'
    reason = metadata.reason || (metadata.riskClass === 'write_local' ? '修改本地数据' : metadata.riskClass === 'exec' ? '执行外部工具' : '调用可能产生副作用的外部工具')
  }

  if (!risk) {
    // 未知/动态工具(MCP、插件):名字像写操作就拦,读操作放行
    if (WRITE_INTENT_RE.test(name)) {
      risk = 'medium'
      reason = '外部工具的写操作'
    } else {
      return { needsApproval: false, risk: 'low', reason: null }
    }
  }

  // ── 参数敏感度加权 ──
  if (SHELL_TOOLS.has(name)) {
    const danger = checkBashCommandDanger(str(safeArgs.command))
    const envKeys = Array.isArray(safeArgs.env_keys)
      ? safeArgs.env_keys.map((key) => str(key).trim()).filter(Boolean).slice(0, 32)
      : []
    reason = danger
      ? `危险命令:${danger.reason}`
      : envKeys.length > 0
        ? `执行代码或 shell 命令，并注入宿主环境变量: ${envKeys.join(', ')}`
        : (name === 'bash_exec' ? '执行 shell 命令' : '执行代码或 shell 命令')
    risk = danger ? 'high' : risk
  } else if (name === 'write_file' || name === 'edit_file' || name === 'file_download') {
    const p = str(safeArgs.path)
    if (isOutsideWorkspacePath(p)) {
      risk = higher(risk, 'high')
      reason = '写入工作区之外的路径'
    } else {
      reason = reason || '修改文件'
    }
  } else if (name === 'apply_patch' || name === 'patch_file') {
    const count = Array.isArray(safeArgs.changes) ? safeArgs.changes.length : 0
    reason = count ? `原子修改 ${count} 个文件` : '原子修改文件'
    if (count > 5) risk = higher(risk, 'high')
  } else if (name === 'fetch_url') {
    const method = str(safeArgs.method).toUpperCase() || 'GET'
    risk = higher(risk, 'medium')
    reason = `对外发起 ${method} 请求`
  } else if (['browser_click', 'browser_type', 'browser_select', 'browser_press'].includes(name)) {
    reason = '在已登录的浏览器会话中代为操作'
  } else if (name === 'browser_open_url' || name === 'browser_navigate' || name === 'connected_app_open') {
    reason = '打开外部应用'
  } else if (name === 'qq_mail_send') {
    reason = '发送外部邮件'
  }

  // Cron/task grants are narrower than remembered or global policies and win
  // when their exact target matches. Local writes are rejected by the grant
  // validator/matcher and still follow the regular approval path.
  const taskGrant = findMatchingTaskGrant(name, safeArgs, taskGrants)
  if (taskGrant) {
    return {
      needsApproval: false,
      risk,
      reason: null,
      authorization: {
        kind: 'task_grant',
        source: 'task_grant',
        toolName: name,
        target: taskGrant.target,
        scope: taskGrant.scope,
        ...(taskGrant.expiresAt ? { expiresAt: taskGrant.expiresAt } : {}),
      },
    }
  }

  // 用户对这个目标范围点过「总是允许」。高风险 shell 和强制逐次确认项不会命中此处。
  const rememberedGrant = findRememberedGrant(name, safeArgs, rememberedGrants)
  if (rememberedGrant && !alwaysConfirm) {
    return {
      needsApproval: false,
      risk,
      reason: null,
      authorization: {
        kind: 'standing_rule',
        toolName: name,
        scope: rememberedGrant.commandPrefix || '',
      },
    }
  }

  // bypass 是唯一对已识别副作用工具全放行的档位。
  if (permissionMode === 'bypass') return { needsApproval: false, risk, reason: null }

  // acceptEdits:可逆的本地编辑自动放行；shell、外部写入及 PDF 覆盖/填表仍需确认。
  if (permissionMode === 'acceptEdits' && EDIT_TOOLS.includes(name) && !alwaysConfirm) {
    return { needsApproval: false, risk, reason: null }
  }

  // off 只关闭审批队列,不代表信任所有调用。没有其它授权时保守拒绝。
  if (mode === 'off') {
    return {
      needsApproval: false,
      denied: true,
      risk,
      reason: '审批队列已关闭,危险操作已保守拒绝。请开启审批,或显式切换到 bypass 模式。',
    }
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
