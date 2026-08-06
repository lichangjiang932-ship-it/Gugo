const ARTIFACT_TOOL_NAMES = new Set(['create_pptx', 'create_docx', 'create_xlsx'])
const WORKSPACE_READ_TOOL_NAMES = new Set([
  'list_directory', 'read_file', 'search_files', 'grep_code', 'find_symbol', 'list_imports',
])
const WORKSPACE_MUTATION_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch'])
const WORKSPACE_EXEC_TOOL_NAMES = new Set(['bash_exec', 'run_project_check'])
const GIT_READ_TOOL_NAMES = new Set(['git_status', 'git_diff'])
const GIT_WRITE_TOOL_NAMES = new Set(['git_commit', 'git_push', 'git_rollback'])
const WEB_TOOL_NAMES = new Set(['web_search', 'fetch_url'])
const ORCHESTRATION_TOOL_NAMES = new Set(['Agent', 'manage_todos', 'reflect', 'request_clarification'])
const CONNECTOR_TOOL_NAMES = new Set([
  'connected_app_list', 'connected_app_open',
  'notion_search', 'notion_fetch_page',
  'github_search_repositories', 'github_get_file',
  'slack_list_channels', 'slack_read_channel',
  'google_drive_search', 'google_drive_get_file',
  'qq_mail_list_recent', 'qq_mail_read', 'qq_mail_send',
])

const LOCAL_PATH_INTENT = /\[LOCAL PATH ACCESS GRANTED\]|\[VERIFIED LOCAL FILESYSTEM ACCESS\]/i
const LOCAL_PATH_GRANT_BLOCK = /\[LOCAL PATH ACCESS GRANTED\]([\s\S]*?)(?:\r?\n\r?\n|$)/i
const WORKSPACE_CONTEXT = /\b(?:code|source|repo(?:sitory)?|workspace|file|folder|directory|path|module|function|class|component|bug|test|build|app)\b|代码|源码|仓库|工作区|文件|文件夹|目录|路径|模块|函数|组件|漏洞|报错|错误|测试|构建|应用/i
const RELATIVE_PATH_CONTEXT = /(?:^|[\s"'`(（])(?:\.{1,2}[\\/])[^\s"'`<>]+|\b[a-z0-9_.-]+[\\/][a-z0-9_.\\/-]+\b|\b(?:readme(?:\.[a-z0-9]+)?|license(?:\.[a-z0-9]+)?|dockerfile|makefile|procfile|gemfile|rakefile|[a-z0-9_.-]+\.(?:md|txt|json|ya?ml|toml|ini|cfg|conf|js|jsx|mjs|cjs|ts|tsx|py|rb|rs|go|java|kt|c|cc|cpp|h|hpp|cs|php|sh|ps1|sql|html|css|scss|vue|svelte|xml|csv|env|lock))\b/i
const WORKSPACE_READ_INTENT = /\b(?:read|inspect|review|search|find|list|open|trace|debug|diagnose|analy[sz]e)\b|读取|阅读|读一下|读一读|查看|看看|看一下|检查|审查|搜索|查找|列出|打开|追踪|调试|诊断|分析/i
const WORKSPACE_MUTATION_INTENT = /\b(?:fix|update|edit|modify|create|implement|refactor|write|delete|remove|rename|move|patch)\b|修复|更新|编辑|修改|创建|实现|重构|写入|删除|移除|重命名|移动|补丁|改动|变更/i
const WORKSPACE_EXEC_INTENT = /\b(?:run|execute|test|build|check|lint|command|shell)\b|运行|执行|测试|构建|检查|命令|脚本/i
const READ_ONLY_CONSTRAINT = /\b(?:read[- ]only|no[- ]write)\b|\b(?:do not|don't|never|without)\b.{0,24}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b|只读|仅查看|只查看|仅分析|只分析|(?:不要|别|禁止|无需).{0,16}(?:修改|编辑|写入|删除|移除|重命名|移动|打补丁|改动|变更|修复)/i
const GIT_INTENT = /\b(?:git|commit|push|rollback|branch|diff|merge|rebase)\b|提交|推送|回滚|分支|差异|合并|变基/i
const GIT_WRITE_INTENT = /\b(?:commit|push|rollback|merge|rebase)\b|提交|推送|回滚|合并|变基/i
const GIT_WRITE_NEGATED = /(?:\b(?:do not|don't|never|without|no)\b|不要|别|禁止|无需).{0,16}(?:\b(?:commit|push|rollback|merge|rebase)\b|提交|推送|回滚|合并|变基)/i
const WEB_INTENT = /\b(?:web|online|internet|browse|search the web|latest|current|news|citation|source|https?:\/\/)\b|联网|上网|网页搜索|最新|新闻|引用|来源/i
const BROWSER_INTENT = /\b(?:browser|website|webpage|page)\b|浏览器|网站|网页|页面/i
const COMPLEX_INTENT = /\b(?:multi-step|implement|refactor|investigate|research|audit|plan|build|fix)\b|多步|实现|重构|调查|研究|审计|规划|构建|修复/i
const MEMORY_INTENT = /\b(?:remember|memorize|preference|from now on|always)\b|记住|记忆|偏好|以后|从今以后|总是/i
const DIRECTORY_REQUEST_INTENT = /\b(?:directory|folder|workspace|local files?)\b|目录|文件夹|工作区|本地文件/i
const WAIT_INTENT = /\b(?:wait|sleep|schedule|until|later|remind)\b|等待|稍后|定时|直到|提醒/i
const CONNECTOR_INTENT = /\b(?:connected app|integration|notion|github|slack|google drive|gdrive|qq ?mail|email|mailbox|airtable|jira|confluence)\b|连接器|已连接|集成|邮箱|邮件|飞书|钉钉|企业微信/i
const TOKEN_STOP_WORDS = new Set([
  'mcp', 'tool', 'tools', 'server', 'api', 'get', 'set', 'list', 'read', 'write', 'open',
  'search', 'find', 'create', 'update', 'delete', 'page', 'file', 'data', 'app', 'connected',
])

function toolName(spec) {
  return String(spec?.function?.name || '')
}

function normalizedIntent(prompt, skillId) {
  return `${String(skillId || '')}\n${String(prompt || '')}`.toLowerCase()
}

function localPathAccessMode(intent) {
  const grant = LOCAL_PATH_GRANT_BLOCK.exec(intent)?.[1] || ''
  if (/access mode:\s*read only\.?/i.test(grant)) return 'read_only'
  if (/access mode:\s*read and write\.?/i.test(grant)) return 'read_write'
  return null
}

function dynamicToolMatchesIntent(name, intent) {
  const tokens = String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token))
  return tokens.some((token) => intent.includes(token))
}

function connectorToolMatchesIntent(name, intent) {
  if (name.startsWith('notion_')) return /\bnotion\b/i.test(intent)
  if (name.startsWith('github_')) return /\bgithub\b/i.test(intent)
  if (name.startsWith('slack_')) return /\bslack\b/i.test(intent)
  if (name.startsWith('google_drive_')) return /\b(?:google drive|gdrive)\b/i.test(intent)
  if (name.startsWith('qq_mail_')) return /\b(?:qq ?mail|email|mailbox)\b|邮箱|邮件/i.test(intent)
  return dynamicToolMatchesIntent(name, intent)
}

function isKnownTool(name) {
  return ARTIFACT_TOOL_NAMES.has(name)
    || WORKSPACE_READ_TOOL_NAMES.has(name)
    || WORKSPACE_MUTATION_TOOL_NAMES.has(name)
    || WORKSPACE_EXEC_TOOL_NAMES.has(name)
    || GIT_READ_TOOL_NAMES.has(name)
    || GIT_WRITE_TOOL_NAMES.has(name)
    || WEB_TOOL_NAMES.has(name)
    || ORCHESTRATION_TOOL_NAMES.has(name)
    || CONNECTOR_TOOL_NAMES.has(name)
    || name === 'remember'
    || name === 'request_directory'
    || name === 'sleep_until'
    || name.startsWith('browser_')
}

export function selectChatToolSpecs({ prompt = '', skillId = null, specs = [] } = {}) {
  const intent = normalizedIntent(prompt, skillId)
  const localAccessMode = localPathAccessMode(intent)
  const hasLocalPath = LOCAL_PATH_INTENT.test(intent)
  const readOnly = localAccessMode === 'read_only' || READ_ONLY_CONSTRAINT.test(intent)
  const hasWorkspaceContext = hasLocalPath || WORKSPACE_CONTEXT.test(intent) || RELATIVE_PATH_CONTEXT.test(intent)
  const hasMutationIntent = WORKSPACE_MUTATION_INTENT.test(intent)
  const hasExecIntent = WORKSPACE_EXEC_INTENT.test(intent)
  const needsWorkspaceRead = hasWorkspaceContext
    && (hasLocalPath || WORKSPACE_READ_INTENT.test(intent) || hasMutationIntent || hasExecIntent)
  const needsWorkspaceMutation = !readOnly
    && hasWorkspaceContext
    && hasMutationIntent
  const needsWorkspaceShell = !readOnly
    && hasWorkspaceContext
    && (hasMutationIntent || hasExecIntent)
  const needsProjectCheck = hasWorkspaceContext && hasExecIntent
  const needsGit = GIT_INTENT.test(intent)
  const needsGitWrite = GIT_WRITE_INTENT.test(intent) && !GIT_WRITE_NEGATED.test(intent)
  const needsWeb = WEB_INTENT.test(intent)
  const needsBrowser = BROWSER_INTENT.test(intent)
  const needsOrchestration = !readOnly
    && COMPLEX_INTENT.test(intent)
    && (hasWorkspaceContext || needsWeb || needsBrowser)
  const needsConnector = CONNECTOR_INTENT.test(intent)

  return (Array.isArray(specs) ? specs : []).filter((spec) => {
    const name = toolName(spec)
    if (!name) return false
    if (ARTIFACT_TOOL_NAMES.has(name)) return true
    if (WORKSPACE_READ_TOOL_NAMES.has(name)) return needsWorkspaceRead
    if (WORKSPACE_MUTATION_TOOL_NAMES.has(name)) return needsWorkspaceMutation
    if (name === 'bash_exec') return needsWorkspaceShell
    if (name === 'run_project_check') return needsProjectCheck
    if (GIT_READ_TOOL_NAMES.has(name)) return needsGit || needsWorkspaceMutation
    if (GIT_WRITE_TOOL_NAMES.has(name)) return needsGit && needsGitWrite
    if (WEB_TOOL_NAMES.has(name)) return needsWeb
    if (name.startsWith('browser_')) return needsBrowser
    if (ORCHESTRATION_TOOL_NAMES.has(name)) return needsOrchestration
    if (name === 'remember') return MEMORY_INTENT.test(intent)
    if (name === 'request_directory') return DIRECTORY_REQUEST_INTENT.test(intent)
    if (name === 'sleep_until') return WAIT_INTENT.test(intent)
    if (name === 'connected_app_list' || name === 'connected_app_open') return needsConnector
    if (CONNECTOR_TOOL_NAMES.has(name)) return connectorToolMatchesIntent(name, intent)
    if (!isKnownTool(name)) return dynamicToolMatchesIntent(name, intent)
    return false
  }).sort((left, right) => toolName(left).localeCompare(toolName(right), 'en'))
}
