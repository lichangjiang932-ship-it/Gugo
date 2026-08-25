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

  /* Fixed brand accent → CSS vars (--accent-h/s/l/--accent). */
  useEffect(() => {
    const hex = ACCENT_DEFAULT_HEX
    const rgb = hexToRgb(hex)
    // Accent controls follow brand identity; semantic status and focus tokens do not.
    document.documentElement.style.setProperty('--color-accent-rgb', rgb)

    const { vars } = applyAccent({ hex })
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value)
    }
    // Clear the retired class during hot reloads and upgrades from old state.
    document.documentElement.classList.remove('theme-accent-strong')
  }, [])

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
