import { listUserToolSpecs } from '../mcp/mcpManager.js'
import { listRegisteredBrowserToolSpecs } from './browserTools.js'
import { CONNECTOR_TOOL_NAMES } from './connectorTools.js'
import { listEnabledIntegrationToolNames } from './integrationsStore.js'
import { getBuiltinSpec } from './toolRegistry.js'

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
  'list_directory', 'read_file', 'read_artifact_source', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'patch_file',
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
    || /(?:联网|网络)\s*(?:搜索|查找|调研)/i.test(text)
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

function emitToolDecision(onDecision, decision) {
  if (typeof onDecision !== 'function') return
  try {
    onDecision(decision)
  } catch {
    // Diagnostics are advisory and must never block tool discovery.
  }
}

function serializeToolPolicy(policy) {
  return {
    legacyFullCatalog: policy.legacyFullCatalog === true,
    localTask: policy.localTask === true,
    includeWeb: policy.includeWeb === true,
    includeBrowser: policy.includeBrowser === true,
    includeMcp: policy.includeMcp === true,
    includeAllConnectors: policy.includeAllConnectors === true,
    connectorProviders: [...(policy.connectorProviders || [])].sort(),
    artifactKinds: [...(policy.artifactKinds || [])].sort(),
    includeGit: policy.includeGit === true,
    includeDocker: policy.includeDocker === true,
    includeWait: policy.includeWait === true,
  }
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
    // Directory authorization grants a path boundary; it must not silently
    // override the independent per-tool execution switch. Keep disabled
    // tools discoverable, but let the runtime gate reject their calls.
    if (!disabled.has(name)) enabled.add(name)
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
  const current = (Array.isArray(specs) ? specs : []).filter((spec) => (
    Boolean(String(spec?.function?.name || '').trim())
  ))
  // Tool switches are execution policy, not schema discovery. Referencing the
  // normalized value here keeps malformed/legacy inputs harmless while every
  // registered schema remains model-visible on refresh and resume.
  if (toolsConfig && typeof toolsConfig === 'object') normalizeServerToolsConfig(toolsConfig)
  return current
}

export async function resolveTurnToolSpecs({
  userId,
  baseSpecs = [],
  enabledConnectorTools,
  prompt = '',
  messages = [],
  skillIds = [],
  onDecision = null,
} = {}) {
  const policy = resolveTurnToolPolicy({ prompt, messages, skillIds })
  const discoveryIssues = []
  let mcpSpecs = []
  try {
    const result = await listUserToolSpecs(userId)
    mcpSpecs = Array.isArray(result?.specs) ? result.specs : []
  } catch {
    // Optional MCP discovery must not block the chat turn.
    discoveryIssues.push({ source: 'mcp', reason: 'discovery_failed' })
  }
  let browserSpecs = []
  try {
    browserSpecs = listRegisteredBrowserToolSpecs()
  } catch {
    discoveryIssues.push({ source: 'browser', reason: 'discovery_failed' })
  }
  const merged = new Map()
  const deliveryControlSpec = getBuiltinSpec('set_deliverables')
  for (const spec of [...baseSpecs, deliveryControlSpec, ...mcpSpecs, ...browserSpecs]) {
    const name = String(spec?.function?.name || '')
    if (name) merged.set(name, spec)
  }
  let connectorTools = enabledConnectorTools
  if (!Array.isArray(connectorTools)) {
    try {
      connectorTools = listEnabledIntegrationToolNames({ userId })
    } catch {
      connectorTools = []
      discoveryIssues.push({ source: 'integrations', reason: 'discovery_failed' })
    }
  }
  const connectorNames = new Set(CONNECTOR_TOOL_NAMES)
  const enabledConnectorNames = new Set(connectorTools)
  const excludedByName = new Map()
  const exclude = (name, reason, stage = 'availability') => {
    if (name && !excludedByName.has(name)) excludedByName.set(name, { name, stage, reason })
    return false
  }
  const readySpecs = [...merged.values()].filter((spec) => {
    const name = toolName(spec)
    if (connectorNames.has(name)) {
      if (!enabledConnectorNames.has(name)) return exclude(name, 'integration_disabled')
    }
    return true
  })
  // Discovery is intentionally independent from intent, approval mode,
  // sandbox authorization and per-tool execution switches. Those controls are
  // enforced when a concrete call is attempted. Keeping the schema catalog
  // stable prevents short follow-ups, refresh/resume and plan mode from
  // fabricating a "tool unavailable this round" state.
  const resolvedSpecs = readySpecs
    .map(canonicalizeToolSpec)
    .sort((left, right) => String(left?.function?.name || '').localeCompare(String(right?.function?.name || ''), 'en'))
  const resolvedNames = new Set(resolvedSpecs.map(toolName))
  emitToolDecision(onDecision, {
    version: 1,
    policy: serializeToolPolicy(policy),
    candidateToolNames: [...merged.keys()].sort().slice(0, 256),
    eligibleToolNames: [...resolvedNames].sort().slice(0, 256),
    excludedTools: [...excludedByName.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .slice(0, 256),
    discoveryIssues: discoveryIssues.slice(0, 16),
  })
  return resolvedSpecs
}
