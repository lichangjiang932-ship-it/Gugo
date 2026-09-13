/** Redact common credential forms before diagnostics are truncated or displayed.
 * @param {unknown} value
 */
export function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/\b(authorization|proxy-authorization)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_-]{12,})\b/giu, '[REDACTED]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret)["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, '$1=[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[REDACTED]@')
}
