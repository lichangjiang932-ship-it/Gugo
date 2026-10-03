import { redactSensitiveText } from './sensitiveText.js'

export const MODEL_PROVIDER_STOP_REASON_ERROR_CODE = 'MODEL_PROVIDER_STOP_REASON_ERROR'
const MAX_DIAGNOSTIC_CHARS = 2000
const MAX_DIAGNOSTIC_SOURCE_CHARS = 128_000

/** Public explanation only: never a model result, tool request, or retry hint.
 * @param {unknown} value
 */
export function normalizeModelProviderStopDiagnostic(value) {
  if (typeof value !== 'string' || value.length > MAX_DIAGNOSTIC_SOURCE_CHARS) return ''
  const publicText = value
    .replace(/<(think|thinking|analysis|reasoning|tool_call|tool_calls|function_call|function)\b[^>]*(?:>|$)[\s\S]*?(?:<\/\1\s*>|$)/giu, '')
    // Orphan closing markers mean their preceding text was not public output.
    .replace(/^[\s\S]*<\/(?:think|thinking|analysis|reasoning|tool_call|tool_calls|function_call|function)\s*>/iu, '')
    .replace(/```[\s\S]*?(?:```|$)/gu, '')
  return Array.from(redactSensitiveText(publicText), (character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || (code >= 127 && code <= 159)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      ? ' ' : character
  }).join('').trim().slice(0, MAX_DIAGNOSTIC_CHARS)
}

/** @param {unknown} failure */
export function modelProviderStopDiagnostic(failure) {
  if (!failure || typeof failure !== 'object' || !('code' in failure)
    || failure.code !== MODEL_PROVIDER_STOP_REASON_ERROR_CODE || !('reason' in failure)) return ''
  return normalizeModelProviderStopDiagnostic(failure.reason)
}
