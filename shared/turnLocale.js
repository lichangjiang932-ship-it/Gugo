export const DEFAULT_TURN_LOCALE = 'zh'

export function normalizeTurnLocale(value, fallback = DEFAULT_TURN_LOCALE) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-')
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized) return 'en'

  const normalizedFallback = String(fallback || '').trim().toLowerCase().replace(/_/g, '-')
  return normalizedFallback === 'zh' || normalizedFallback.startsWith('zh-') ? 'zh' : 'en'
}
