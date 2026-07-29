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

/**
 * 产物工具跑完后是否直接结束整轮对话。
 *
 * ★ 以前只要产出任何 artifact 就 break —— 于是模型刚生成完文件,
 * 循环立刻中断,它没有机会说「我改了什么、为什么改、还有什么问题」。
 * 用户看到的就是:一堆工具调用 + 一个凭空出现的文件,零解释。
 *
 * 现在只有「产物本身就是最终答复」的场景才提前结束:
 * 用户明确要一份 PPT/文档,文件给了就等于答完了。
 * 而在改代码、调研这类任务里,产物只是中间物,必须让模型继续说完。
 *
 * @param {object} artifact
 * @param {object} [context]
 * @param {boolean} [context.artifactWasRequested] 用户是否明确要这类产物(有 skillId 即视为要)
 */
export function shouldStopAfterArtifactTool(artifact, { artifactWasRequested = false } = {}) {
  if (!artifact || !artifact.type || !artifact.source) return false
  // 没明确要产物 = 产物是中间步骤,不能拿它当结束信号
  return artifactWasRequested
}

export function buildChatFailureMessage(message = '') {
  const detail = String(message || '模型代理调用失败。')
  const base = `\n\n模型调用失败：${detail}`
  if (CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return `${base}\n\n请联系管理员检查后端 .env 中的 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。`
  }
  return base
}
