const SKILL_ARTIFACT_TYPES = {
  ppt: 'pptx',
  htmlppt: 'html',
  doc: 'docx',
  excel: 'xlsx',
}

const HTMLPPT_BLOCKED_TOOLS = new Set([
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_html_app',
  'create_react_component',
  'create_mermaid',
  'create_chart',
  'create_svg',
])

const CONFIG_ERROR_PATTERNS = [
  /后端模型未配置/,
  /缺少\s+MODEL_/,
  /MODEL_(?:BASE_URL|NAME|API_KEY)/,
  /API Key 无效|API Key .*权限/,
  /端点不可达/,
  /模型或端点不存在/,
  /模型名称无效/,
]

export function artifactTypeForSkill(skillId) {
  return SKILL_ARTIFACT_TYPES[skillId] || undefined
}

export function filterToolNamesForSkill(toolNames = [], skillId = '') {
  const names = Array.from(toolNames || []).filter((name) => typeof name === 'string')
  if (skillId !== 'htmlppt') return names
  return names.filter((name) => !HTMLPPT_BLOCKED_TOOLS.has(name))
}

export function buildAssistantToolCallsMessage(toolCalls = []) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    })),
  }
}

export function shouldStopAfterArtifactTool(artifact) {
  return !!(artifact && artifact.type && artifact.source)
}

export function buildChatFailureMessage(message = '') {
  const detail = String(message || '模型代理调用失败。')
  const base = `\n\n模型调用失败：${detail}`
  if (CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return `${base}\n\n请联系管理员检查后端 .env 中的 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。`
  }
  return base
}
