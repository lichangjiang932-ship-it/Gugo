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

const PUBLIC_GENERIC_FAILURE = '任务执行遇到问题，尚未完成。请重试；若仍失败，请检查所选模型是否支持当前工具。'
const PUBLIC_MODEL_CONFIGURATION_FAILURE = '模型服务尚未正确配置。'
const INTERNAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:tool|artifact|model)[_-](?:execution|write|call)?[_-]?failed/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /任务未完全完成[^\n]*(?:保留|保存)/,
  /(?:已保留|保存当前)[^\n]*(?:残缺|文件|进展|工具结果)/,
]

function publicFailureDetail(message) {
  const detail = String(message || '').trim()
  if (!detail) return PUBLIC_GENERIC_FAILURE
  if (CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return PUBLIC_MODEL_CONFIGURATION_FAILURE
  }
  if (INTERNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return PUBLIC_GENERIC_FAILURE
  }
  // Raw provider and runtime errors are normally English-only. They are useful
  // in logs, but presenting them as the assistant's final reply exposes
  // implementation details without giving the user an actionable next step.
  if (!/[\u3400-\u9fff]/u.test(detail)) return PUBLIC_GENERIC_FAILURE
  return detail
}

export function artifactTypeForSkill(skillId) {
  return SKILL_ARTIFACT_TYPES[canonicalizeSkillId(skillId)] || undefined
}

export function buildChatFailureMessage(message = '') {
  const rawDetail = String(message || '')
  const detail = publicFailureDetail(rawDetail)
  const base = `\n\n${detail}`
  if (CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(rawDetail))) {
    return `${base}\n\n请前往“设置 → 模型”选择模型服务并保存 API Key；自定义部署也可以在高级配置中填写接口地址和模型名称。`
  }
  return base
}

export function buildChatFailureDisplayKey(turnId, error) {
  const normalizedTurnId = String(turnId || 'unknown-turn').trim() || 'unknown-turn'
  const code = String(error?.serverFailure?.code || error?.code || 'MODEL_CALL_FAILED').trim() || 'MODEL_CALL_FAILED'
  return `${normalizedTurnId}:${code}`
}

export function getVisibleModelErrorMessage(error, t) {
  if (error?.code === 'EMPTY_MODEL_RESPONSE_LENGTH') return t('errors.emptyModelResponseLength')
  if (error?.code === 'EMPTY_MODEL_RESPONSE') return t('errors.emptyModelResponse')
  return publicFailureDetail(error?.message || String(error || ''))
}
