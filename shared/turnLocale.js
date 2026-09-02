import {
  DEFAULT_PRODUCT_LANGUAGE,
  normalizeProductLanguage,
} from './productLanguage.js'

export const DEFAULT_TURN_LOCALE = DEFAULT_PRODUCT_LANGUAGE

export function normalizeTurnLocale(value, fallback = DEFAULT_TURN_LOCALE) {
  return normalizeProductLanguage(value, fallback)
}
