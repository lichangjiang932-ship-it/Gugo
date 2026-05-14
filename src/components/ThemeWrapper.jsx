import { useEffect } from 'react'
import { useAppContext } from '../store/AppContext'

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
      if (state.theme === 'system') {
        document.documentElement.dataset.theme = getSystemTheme()
      } else {
        document.documentElement.dataset.theme = state.theme
      }
    }

    apply()

    if (state.theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      media.addEventListener('change', apply)
      return () => media.removeEventListener('change', apply)
    }
  }, [state.theme])

  /* accent color */
  useEffect(() => {
    const rgb = hexToRgb(state.accentColor || '#E86A3C')
    document.documentElement.style.setProperty('--color-ember-rgb', rgb)
  }, [state.accentColor])

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
