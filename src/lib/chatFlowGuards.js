import { canonicalizeSkillId } from '../../shared/artifactIntent.js'

const SKILL_ARTIFACT_TYPES = {
  ppt: 'pptx',
  doc: 'docx',
  excel: 'xlsx',
  webpage: 'html',
}

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
  return SKILL_ARTIFACT_TYPES[canonicalizeSkillId(skillId)] || undefined
}

export function buildChatFailureMessage(message = '') {
  const detail = String(message || '模型代理调用失败。')
  // ★ 执行/失败状态行按用户要求用英文技术表述,与界面语言无关。
  const base = `\n\nModel call failed: ${detail}`
  if (CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return `${base}\n\n请前往“设置 → 模型”选择模型服务并保存 API Key；自定义部署也可以在高级配置中填写接口地址和模型名称。`
  }
  return base
}

export function getVisibleModelErrorMessage(error, t) {
  if (error?.code === 'EMPTY_MODEL_RESPONSE_LENGTH') return t('errors.emptyModelResponseLength')
  if (error?.code === 'EMPTY_MODEL_RESPONSE') return t('errors.emptyModelResponse')
  return error?.message || String(error || '')
}
