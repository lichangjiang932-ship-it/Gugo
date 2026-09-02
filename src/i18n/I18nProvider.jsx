import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_LANGUAGE,
  normalizeUiLanguage,
  SUPPORTED_LANGUAGES,
  translateKey,
} from './translations.js'

const STORAGE_KEY = 'lang'
const I18nContext = createContext(null)

function readInitialLang() {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY)
    if (stored) {
      const normalized = normalizeUiLanguage(stored)
      if (normalized !== stored) window.localStorage?.setItem(STORAGE_KEY, normalized)
      return normalized
    }
  } catch {
    // localStorage 不可用（隐私模式/SSR）→ 默认
  }
  return DEFAULT_LANGUAGE
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(readInitialLang)

  const setLang = useCallback((next) => {
    const normalized = normalizeUiLanguage(next)
    setLangState(normalized)
    try {
      window.localStorage?.setItem(STORAGE_KEY, normalized)
    } catch {
      // 忽略写入失败
    }
  }, [])

  // 跨标签页同步
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        setLangState(normalizeUiLanguage(e.newValue))
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const value = useMemo(() => ({
    lang,
    setLang,
    languages: SUPPORTED_LANGUAGES,
    t: (key, vars) => {
      const raw = translateKey(key, lang)
      if (!vars || typeof raw !== 'string') return raw
      return raw.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`))
    },
  }), [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useT() {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // 没包 Provider 时也别让组件崩 —— 退化到纯 zh
    return {
      lang: DEFAULT_LANGUAGE,
      setLang: () => {},
      languages: SUPPORTED_LANGUAGES,
      t: (key, vars) => {
        const raw = translateKey(key, DEFAULT_LANGUAGE)
        if (!vars || typeof raw !== 'string') return raw
        return raw.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`))
      },
    }
  }
  return ctx
}
