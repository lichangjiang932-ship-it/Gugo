export const DEFAULT_PRODUCT_LANGUAGE = 'zh'

const CHINESE_PRODUCT_LOCALES = new Set(['zh', 'zh-cn', 'zh-hans'])

function normalizeLocaleCode(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-')
}

export function normalizeProductLanguage(value, fallback = DEFAULT_PRODUCT_LANGUAGE) {
  const normalized = normalizeLocaleCode(value)
  if (CHINESE_PRODUCT_LOCALES.has(normalized)) return 'zh'
  if (normalized) return 'en'
  return CHINESE_PRODUCT_LOCALES.has(normalizeLocaleCode(fallback)) ? 'zh' : 'en'
}
