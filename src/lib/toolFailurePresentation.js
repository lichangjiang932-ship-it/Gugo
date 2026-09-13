import { redactSensitiveText } from '../../shared/sensitiveText.js'

function resultObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.length > 65536) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function compactReason(value) {
  if (typeof value !== 'string') return ''
  const line = redactSensitiveText(value).slice(0, 8192).split(String.fromCharCode(27))
    .map((part, index) => index === 0 ? part : part.replace(/^\[[0-9;]*[A-Za-z]/, '')).join('')
    .split(/\r?\n/).map((part) => part.trim()).find(Boolean) || ''
  const clean = Array.from(line, (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ? ' ' : character).join('').replace(/\s+/g, ' ').trim()
  if (!clean || /^(?:\{|\[\s*(?:\{|\[|"|\]))/.test(clean)) return ''
  return clean.length > 220 ? `${clean.slice(0, 219)}…` : clean
}

/** A short observed failure, never inferred from arguments or a retry promise. */
export function toolFailureSummary(call = {}, t) {
  if (call.status !== 'error') return ''
  const result = resultObject(call.result)
  if (typeof t === 'function' && (call.errorCode || result?.code) === 'PPTX_CONTENT_OVERFLOW') {
    const path = [result?.error, call.error?.message, call.error].filter((value) => typeof value === 'string')
      .join(' ').match(/slides\[(\d{1,5})\]\.elements\[(\d{1,5})\]/)
    if (path) return t('toolActivity.pptxFrameOverflow', { slide: Number(path[1]) + 1, element: Number(path[2]) + 1 })
  }
  const candidates = [
    call.errorHint,
    result?.error?.hint,
    result?.error?.message,
    result?.error,
    result?.message,
    call.error?.message,
    call.error,
    result?.stderr,
    call.errorCode,
    result?.code,
  ]
  if (!result && typeof call.result === 'string') candidates.push(call.result)
  return candidates.map(compactReason).find(Boolean) || ''
}

export function toolFailureFacts(call = {}, t) {
  if (call.status !== 'error') return []
  const status = call.errorStatus == null || call.errorStatus === '' ? NaN : Number(call.errorStatus)
  const attempts = Number(call.attempts)
  return [...new Set([
    call.errorCode,
    Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : '',
    Number.isInteger(attempts) && attempts > 0 ? `${attempts}x` : '',
    call.retryable ? t('chatMessages.toolRetry') : '',
  ].filter(Boolean))]
}
