import { listUserToolSpecs } from '../mcp/mcpManager.js'
import { isToolPermittedForUser } from '../db.js'
import { listRegisteredBrowserToolSpecs } from './browserTools.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import { CONNECTOR_TOOL_NAMES } from './connectorTools.js'
import { listEnabledIntegrationToolNames } from './integrationsStore.js'
import { isWebSearchReady } from './webSearchService.js'

function normalizeNames(values, limit = 256) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((name) => name.trim()).filter(Boolean))]
    .slice(0, limit)
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalizeJson(value[key])
    return result
  }, {})
}

function canonicalizeToolSpec(spec) {
  return canonicalizeJson(spec)
}

const LOCAL_TASK_TOOL_NAMES = new Set([
  'list_directory', 'read_file', 'read_artifact_source', 'write_file', 'edit_file', 'apply_patch', 'patch_file',
  'bash_exec', 'run_command', 'bash_background', 'process_list', 'process_kill',
  'grep_code', 'find_symbol', 'list_imports', 'run_project_check', 'run_test', 'docker_exec',
  'git_status', 'git_diff', 'git_write', 'git_commit', 'git_push', 'git_rollback',
  'request_directory', 'file_download', 'rewind_files', 'set_deliverables',
  'manage_todos', 'request_clarification', 'reflect', 'Agent', 'sleep_until',
  'create_pptx', 'create_docx', 'create_xlsx', 'create_pdf', 'create_html_app', 'render_pdf_pages',
  'generate_image', 'image_info', 'image_transform', 'media_probe', 'media_transform',
  'pdf_info', 'pdf_text', 'pdf_transform', 'archive_create', 'archive_list', 'archive_extract',
  'batch_rename', 'file_hash_manifest',
])

const LOCAL_CORE_TOOL_NAMES = new Set([
  'list_directory', 'read_file', 'read_artifact_source', 'write_file', 'edit_file', 'apply_patch', 'patch_file',
  'bash_exec', 'run_command', 'bash_background', 'process_list', 'process_kill',
  'grep_code', 'find_symbol', 'list_imports', 'run_project_check', 'run_test',
  'request_directory', 'file_download', 'rewind_files', 'set_deliverables',
  'manage_todos', 'request_clarification', 'reflect', 'Agent',
])

const ARTIFACT_KIND_TOOLS = {
  html: new Set(['create_html_app', 'generate_image', 'image_info', 'image_transform']),
  presentation: new Set(['create_pptx', 'generate_image', 'image_info', 'image_transform']),
  document: new Set(['create_docx', 'generate_image', 'image_info', 'image_transform']),
  spreadsheet: new Set(['create_xlsx']),
  pdf: new Set(['create_pdf', 'render_pdf_pages', 'pdf_info', 'pdf_text', 'pdf_transform', 'image_info', 'image_transform']),
  image: new Set(['generate_image', 'render_pdf_pages', 'image_info', 'image_transform']),
  media: new Set(['media_probe', 'media_transform', 'image_info', 'image_transform']),
  archive: new Set(['archive_create', 'archive_list', 'archive_extract', 'batch_rename', 'file_hash_manifest']),
}

const CONNECTOR_PROVIDERS = [
  'microsoft_teams', 'google_calendar', 'google_sheets', 'google_drive', 'connected_app',
  'qq_mail', 'salesforce', 'confluence', 'dropbox', 'onedrive', 'todoist', 'zendesk',
  'hubspot', 'airtable', 'clickup', 'gitlab', 'github', 'notion', 'slack', 'discord',
  'linear', 'trello', 'asana', 'monday', 'jira', 'mail',
]

const PROVIDER_ALIASES = new Map([
  ['microsoft_teams', ['microsoft teams', 'ms teams', '微软 teams']],
  ['google_calendar', ['google calendar', '谷歌日历']],
  ['google_sheets', ['google sheets', '谷歌表格']],
  ['google_drive', ['google drive', '谷歌云端硬盘', '谷歌云盘']],
  ['qq_mail', ['qq mail', 'qq email', 'qq 邮箱', 'qq邮箱']],
  ['connected_app', ['connected app', '已连接应用', '连接的应用']],
  ...['salesforce', 'confluence', 'dropbox', 'onedrive', 'todoist', 'zendesk', 'hubspot',
    'airtable', 'clickup', 'gitlab', 'github', 'slack', 'discord', 'trello', 'asana',
    'jira'].map((provider) => [provider, [provider]]),
  ['notion', ['notion page', 'notion workspace', 'notion database', 'notion 页面', 'notion 工作区']],
  ['linear', ['linear.app', 'linear issue', 'linear ticket', 'linear task', 'linear 工单', 'linear 任务']],
  ['monday', ['monday.com', 'monday board', 'monday item', 'monday 看板', 'monday 任务']],
])

function toolName(spec) {
  return String(spec?.function?.name || '')
}

function effectivePermissionMode(userId, explicitMode) {
  const normalized = String(explicitMode || '').trim()
  if (normalized) return normalized
  if (!userId) return null
  try {
    return getApprovalMode({ userId })
  } catch {
    // Tool discovery is advisory and must not block a chat turn. The runtime
    // permission gate remains authoritative when settings storage is unavailable.
    return null
  }
}

function isVisibleToUser(userId, name) {
  if (!userId || !name) return Boolean(name)
  try {
    return isToolPermittedForUser(userId, name)
  } catch {
    // Preserve availability on a transient settings read failure; execution
    // still passes through the same server-side permission gate.
    return true
  }
}

function connectorProvider(name) {
  return CONNECTOR_PROVIDERS.find((provider) => name === provider || name.startsWith(`${provider}_`)) || null
}

function historicalToolNames(messages) {
  const names = new Set()
  const addCalls = (calls) => {
    for (const call of Array.isArray(calls) ? calls : []) {
      const name = String(call?.function?.name || call?.name || '').trim()
      if (name) names.add(name)
    }
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'tool' && message?.name) names.add(String(message.name))
    addCalls(message?.tool_calls)
    addCalls(message?.toolCalls)
    addCalls(message?.modelContext?.toolCalls)
  }
  return names
}

function includesAny(text, values) {
  return values.some((value) => text.includes(value))
}

/**
 * Progressive tool disclosure for real chat turns. The policy only controls
 * model-visible schemas; execution still uses the canonical registry and its
 * approval/risk metadata. Calls without intent context retain the legacy full
 * catalog so catalog/configuration consumers remain compatible.
 */
export function resolveTurnToolPolicy({ prompt = '', messages = [], skillIds = [] } = {}) {
  const text = String(prompt || '').trim().toLowerCase()
  const skills = normalizeNames(skillIds, 32).map((value) => value.toLowerCase())
  const used = historicalToolNames(messages)
  const hasIntentContext = Boolean(text || skills.length || (Array.isArray(messages) && messages.length))
  if (!hasIntentContext) {
    return {
      legacyFullCatalog: true,
      localTask: false,
      includeWeb: true,
      includeBrowser: true,
      includeMcp: true,
      explicitMcp: true,
      includeAllConnectors: true,
      connectorProviders: new Set(CONNECTOR_PROVIDERS),
      historicalTools: used,
    }
  }

  const localTask = /(?:网页|网站|页面|幻灯片|演示文稿|文档|表格|工作簿|图片|图像|视频|音频|压缩包|文件|目录|文件夹|项目|代码|源码)/i.test(text)
    || /\b(?:website|webpage|landing page|html|css|javascript|typescript|react|vue|frontend|pptx?|powerpoint|slides?|docx?|word document|xlsx?|spreadsheet|pdf|image|video|audio|archive|zip|file|folder|directory|project|codebase|source code)\b/i.test(text)
    || [...used].some((name) => LOCAL_TASK_TOOL_NAMES.has(name))
  const connectorSkill = skills.some((skill) => /connector/.test(skill))
  const mcpSkill = skills.some((skill) => /mcp/.test(skill))
  const browserSkill = skills.some((skill) => /browser|playwright/.test(skill))
  const webSkill = skills.some((skill) => /web-search|web_search/.test(skill))
  const genericRemote = connectorSkill || /(?:连接器|已连接应用|连接的应用)/i.test(text)
    || /\b(?:connector|connected apps?)\b/i.test(text)
  const explicitMcp = mcpSkill || /(?:模型上下文协议)/i.test(text) || /\bmcp\b/i.test(text)
  const includeMcp = explicitMcp
    || [...used].some((name) => name.startsWith('mcp__'))
  const includeBrowser = browserSkill
    || /(?:浏览器|打开.{0,20}(?:网页|网站|链接)|访问.{0,20}(?:网页|网站|链接)|点击.{0,20}(?:页面|按钮)|(?:填写|填入).{0,20}(?:表单|网页)|网页截图)/i.test(text)
    || /\b(?:browser|navigate|open (?:the )?(?:site|website|url|link)|click (?:the )?(?:page|button)|fill (?:the )?(?:form|page)|page screenshot)\b/i.test(text)
    || [...used].some((name) => name.startsWith('browser_'))
  const includeWeb = webSkill
    || /https?:\/\//i.test(text)
    || /(?:搜索|查找|调研).{0,12}(?:网络|网上|互联网|在线资料)|(?:网络|网上|互联网).{0,12}(?:搜索|查找|调研)/i.test(text)
    || /\b(?:web search|search (?:the )?(?:web|internet|online)|research online|fetch (?:the )?(?:url|page))\b/i.test(text)
    || used.has('web_search') || used.has('fetch_url')

  const connectorProviders = new Set()
  if (genericRemote) CONNECTOR_PROVIDERS.forEach((provider) => connectorProviders.add(provider))
  for (const [provider, aliases] of PROVIDER_ALIASES) {
    if (includesAny(text, aliases)) connectorProviders.add(provider)
  }
  if (/(?:发送|查看|读取|搜索|收件箱).{0,12}(?:邮件|邮箱)|(?:send|read|search|list).{0,12}(?:mail|email)|\binbox\b/i.test(text)) {
    connectorProviders.add('mail')
  }
  for (const name of used) {
    const provider = connectorProvider(name)
    if (provider) connectorProviders.add(provider)
  }

  const artifactKinds = new Set()
  const addKind = (kind, pattern) => {
    if (pattern.test(text)) artifactKinds.add(kind)
  }
  addKind('html', /(?:网页|网站|页面)|\b(?:website|webpage|landing page|html|css|frontend|react|vue)\b/i)
  addKind('presentation', /(?:幻灯片|演示文稿)|\b(?:pptx?|powerpoint|slides?|presentation)\b/i)
  addKind('document', /(?:word\s*)?文档|\b(?:docx?|word document)\b/i)
  addKind('spreadsheet', /(?:表格|工作簿)|\b(?:xlsx?|spreadsheet|workbook)\b/i)
  addKind('pdf', /\bpdf\b/i)
  addKind('image', /(?:图片|图像|插图|封面)|\b(?:image|picture|illustration|cover art)\b/i)
  addKind('media', /(?:视频|音频)|\b(?:video|audio|media)\b/i)
  addKind('archive', /(?:压缩包|打包|解压)|\b(?:archive|zip|tar)\b/i)
  for (const name of used) {
    for (const [kind, names] of Object.entries(ARTIFACT_KIND_TOOLS)) {
      if (names.has(name)) artifactKinds.add(kind)
    }
  }

  return {
    legacyFullCatalog: false,
    localTask,
    includeWeb,
    includeBrowser,
    includeMcp,
    explicitMcp,
    includeAllConnectors: genericRemote,
    connectorProviders,
    historicalTools: used,
    artifactKinds,
    includeGit: /(?:\bgit\b|提交|推送|版本库)/i.test(text) || [...used].some((name) => name.startsWith('git_')),
    includeDocker: /(?:\bdocker\b|\bcontainer\b|容器)/i.test(text) || used.has('docker_exec'),
    includeWait: /(?:等待|定时|到.{0,12}时间)|\b(?:wait|sleep|until)\b/i.test(text) || used.has('sleep_until'),
  }
}

function localToolMatchesPolicy(name, policy) {
  if (LOCAL_CORE_TOOL_NAMES.has(name)) return true
  if (name.startsWith('git_')) return policy.includeGit
  if (name === 'docker_exec') return policy.includeDocker
  if (name === 'sleep_until') return policy.includeWait
  for (const kind of policy.artifactKinds) {
    if (ARTIFACT_KIND_TOOLS[kind]?.has(name)) return true
  }
  return false
}

function mcpSpecMatchesPolicy(name, policy) {
  if (!name.startsWith('mcp__')) return true
  if (policy.explicitMcp) return true
  const prefix = name.split('__').slice(0, 2).join('__')
  return [...policy.historicalTools].some((used) => used === name || used.startsWith(`${prefix}__`))
}

export function normalizeServerToolsConfig(value) {
  const disabled = normalizeNames(value?.disabled)
  const disabledSet = new Set(disabled)
  const enabled = normalizeNames(value?.enabled).filter((name) => !disabledSet.has(name))
  return { enabled, disabled }
}

export function applyDirectoryAuthorizationToolsConfig(toolsConfig, resolution) {
  const normalized = normalizeServerToolsConfig(toolsConfig)
  if (resolution?.type !== 'directory_authorization' || resolution?.approved !== true) {
    return normalized
  }
  const accessMode = String(resolution.access_mode || resolution.accessMode || '').trim()
  if (!['read_only', 'read_write'].includes(accessMode)) return normalized

  const required = [
    'list_directory',
    'read_file',
    ...(accessMode === 'read_write'
      ? ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']
      : []),
  ]
  const enabled = new Set(normalized.enabled)
  const disabled = new Set(normalized.disabled)
  for (const name of required) {
    enabled.add(name)
    disabled.delete(name)
  }
  return {
    enabled: [...enabled].sort(),
    disabled: [...disabled].sort(),
  }
}

export function restoreDirectoryAuthorizationToolSpecs(baseSpecs, resolution, fallbackSpecs = []) {
  const current = Array.isArray(baseSpecs) ? baseSpecs : []
  if (resolution?.type !== 'directory_authorization' || resolution?.approved !== true) {
    return current
  }
  const accessMode = String(resolution.access_mode || resolution.accessMode || '').trim()
  if (!['read_only', 'read_write'].includes(accessMode)) return current

  const requiredNames = new Set([
    'list_directory',
    'read_file',
    ...(accessMode === 'read_write'
      ? ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']
      : []),
  ])
  const restored = new Map()
  for (const spec of current) {
    const name = String(spec?.function?.name || '')
    if (name) restored.set(name, spec)
  }
  for (const spec of Array.isArray(fallbackSpecs) ? fallbackSpecs : []) {
    const name = String(spec?.function?.name || '')
    if (requiredNames.has(name) && !restored.has(name)) restored.set(name, spec)
  }
  return [...restored.values()]
}

export function applyServerToolsConfig(specs, toolsConfig) {
  const normalized = normalizeServerToolsConfig(toolsConfig)
  const disabled = new Set(normalized.disabled)
  const enabled = new Set(normalized.enabled)
  // File mutation and post-mutation verification are one capability contract.
  // Older/persisted UI state may explicitly enable a write tool while keeping
  // the read tools at their historical false defaults. Keep the dangerous
  // mutation switches authoritative, but never advertise a write capability
  // without its read-only verification companions.
  if (enabled.has('write_file') || enabled.has('edit_file')
    || enabled.has('apply_patch') || enabled.has('patch_file')) {
    disabled.delete('list_directory')
    disabled.delete('read_file')
  }
  if (enabled.has('git_commit') || enabled.has('git_push')
    || enabled.has('git_rollback') || enabled.has('git_write')) {
    disabled.delete('git_status')
    disabled.delete('git_diff')
  }
  return (Array.isArray(specs) ? specs : []).filter((spec) => {
    const name = String(spec?.function?.name || '')
    return name && !disabled.has(name)
  })
}

export async function resolveTurnToolSpecs({
  userId,
  baseSpecs = [],
  toolsConfig,
  permissionMode,
  webSearchReady = isWebSearchReady({ userId }),
  enabledConnectorTools,
  prompt = '',
  messages = [],
  skillIds = [],
} = {}) {
  const policy = resolveTurnToolPolicy({ prompt, messages, skillIds })
  const resolvedPermissionMode = effectivePermissionMode(userId, permissionMode)
  let mcpSpecs = []
  if (policy.includeMcp) {
    try {
      const result = await listUserToolSpecs(userId)
      mcpSpecs = Array.isArray(result?.specs) ? result.specs : []
    } catch {
      // Optional MCP discovery must not block the chat turn.
    }
  }
  let browserSpecs = []
  if (policy.includeBrowser) {
    try { browserSpecs = listRegisteredBrowserToolSpecs() } catch { /* optional browser tools */ }
  }
  const merged = new Map()
  for (const spec of [...baseSpecs, ...mcpSpecs, ...browserSpecs]) {
    const name = String(spec?.function?.name || '')
    if (name) merged.set(name, spec)
  }
  let connectorTools = enabledConnectorTools
  if (!Array.isArray(connectorTools)) {
    try {
      connectorTools = listEnabledIntegrationToolNames({ userId })
    } catch {
      connectorTools = []
    }
  }
  const connectorNames = new Set(CONNECTOR_TOOL_NAMES)
  const enabledConnectorNames = new Set(connectorTools)
  const readySpecs = [...merged.values()].filter((spec) => {
    const name = toolName(spec)
    if (!isVisibleToUser(userId, name)) return false
    // "Allow all" grants path access directly in localFileAccessService. Do
    // not advertise a directory-authorization action that can only add a
    // redundant pause and contradicts the effective runtime authority.
    if (resolvedPermissionMode === 'bypass' && name === 'request_directory') return false
    if (name === 'web_search') return webSearchReady === true && policy.includeWeb
    if (name === 'fetch_url') return policy.includeWeb
    if (name.startsWith('browser_')) return policy.includeBrowser
    if (name.startsWith('mcp__')) return policy.includeMcp && mcpSpecMatchesPolicy(name, policy)
    if (connectorNames.has(name)) {
      const provider = connectorProvider(name)
      return enabledConnectorNames.has(name)
        && (policy.includeAllConnectors || policy.connectorProviders.has(provider))
    }
    if (policy.localTask && !localToolMatchesPolicy(name, policy)) return false
    return true
  })
  return applyServerToolsConfig(readySpecs, toolsConfig)
    .map(canonicalizeToolSpec)
    .sort((left, right) => String(left?.function?.name || '').localeCompare(String(right?.function?.name || ''), 'en'))
}
