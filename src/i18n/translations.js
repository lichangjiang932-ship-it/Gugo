// Public i18n API. Translation data lives in cohesive zh/en domain modules.
import {
  DEFAULT_PRODUCT_LANGUAGE,
  normalizeProductLanguage,
} from '../../shared/productLanguage.js'
import { translations } from './domains/index.js'
import { SLASH_ACTION_COPY } from './domains/slashActionCopy.js'

export const SUPPORTED_LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
]

export const DEFAULT_LANGUAGE = DEFAULT_PRODUCT_LANGUAGE

export function normalizeUiLanguage(value) {
  return normalizeProductLanguage(value, DEFAULT_LANGUAGE)
}

export { translations, SLASH_ACTION_COPY }

export function lookup(dict, key) {
  if (!dict || typeof key !== 'string') return undefined
  const parts = key.split('.')
  let cur = dict
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p]
    else return undefined
  }
  return typeof cur === 'string' ? cur : undefined
}

export function translateKey(key, lang = DEFAULT_LANGUAGE) {
  const normalizedLang = normalizeUiLanguage(lang)
  const primary = lookup(translations[normalizedLang], key)
  if (primary !== undefined) return primary
  if (normalizedLang !== DEFAULT_LANGUAGE) {
    const fallback = lookup(translations[DEFAULT_LANGUAGE], key)
    if (fallback !== undefined) return fallback
  }
  const tail = String(key).split('.').pop()
  return tail || ''
}
