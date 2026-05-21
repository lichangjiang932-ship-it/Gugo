import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppContext } from '../store/AppContext'
import LeftRail from './LeftRail'

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function ThemeWrapper({ children, headerName, headerPath }) {
  const { state } = useAppContext()
  const location = useLocation()

  /* Theme */
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

  /* Font size */
  useEffect(() => {
    const scale = state.fontSize === 'small' ? 0.875 : state.fontSize === 'large' ? 1.125 : 1
    document.documentElement.style.fontSize = `${scale * 16}px`
  }, [state.fontSize])

  /* Density */
  useEffect(() => {
    document.documentElement.dataset.density = state.density || 'comfortable'
  }, [state.density])

  /* Animations */
  useEffect(() => {
    document.documentElement.dataset.animations = state.animations !== false ? 'true' : 'false'
  }, [state.animations])

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Page Header */}
        {headerName && (
          <div className="flex items-center justify-between px-8 py-4 border-b border-ink-fade/15 bg-paper/60 backdrop-blur-md shrink-0 z-10">
            <div>
              <span className="section-label">{headerName.toUpperCase()}</span>
              <h1 className="font-hand text-2xl text-ink mt-0.5 leading-tight">{headerName}</h1>
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
