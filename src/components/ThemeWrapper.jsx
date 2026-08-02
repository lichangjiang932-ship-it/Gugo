import { useEffect } from 'react'
import { useAppContext } from '../store/AppContext'
import { applyAccent, ACCENT_DEFAULT_HEX } from '../lib/themeAccent.js'
import { normalizeThemeMode } from '../lib/themeMode.js'

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.substring(0, 2), 16)
  const g = parseInt(clean.substring(2, 4), 16)
  const b = parseInt(clean.substring(4, 6), 16)
  return `${r} ${g} ${b}`
}

export default function ThemeWrapper({ children }) {
  const { state } = useAppContext()

  useEffect(() => {
    const apply = () => {
      const theme = normalizeThemeMode(state.theme)
      if (theme === 'system') {
        document.documentElement.dataset.theme = getSystemTheme()
      } else {
        document.documentElement.dataset.theme = theme
      }
    }

    apply()

    if (normalizeThemeMode(state.theme) === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      media.addEventListener('change', apply)
      return () => media.removeEventListener('change', apply)
    }
  }, [state.theme])

  /* accent color + strong mode → CSS vars (--accent-h/s/l/--accent) */
  useEffect(() => {
    const hex = state.accentColor || ACCENT_DEFAULT_HEX
    const strong = !!state.strongAccent
    const rgb = hexToRgb(hex)
    // 保留旧 ember RGB 通道,免得既有 bg-ember 类失效
    document.documentElement.style.setProperty('--color-ember-rgb', rgb)

    const { vars, className } = applyAccent({ hex, strong })
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value)
    }
    document.documentElement.classList.toggle('theme-accent-strong', !!className)
  }, [state.accentColor, state.strongAccent])

  /* font size scale */
  useEffect(() => {
    const scale =
      state.fontSize === 'small' ? 0.875 : state.fontSize === 'large' ? 1.125 : 1
    document.documentElement.style.setProperty('--font-size-scale', String(scale))
    document.documentElement.style.fontSize = `${scale * 16}px`
  }, [state.fontSize])

  /* density */
  useEffect(() => {
    document.documentElement.dataset.density = state.density || 'comfortable'
  }, [state.density])

  /* animations */
  useEffect(() => {
    document.documentElement.dataset.animations = state.animationsEnabled ? 'true' : 'false'
  }, [state.animationsEnabled])

  return children
}
