import { useCallback } from 'react'

import { useLocation, useNavigate } from './router.jsx'
import {
  resolveSettingsNavFromSearch,
  resolveSettingsSectionFromSearch,
  settingsPathForSection,
} from './settingsNavigation.js'

export default function useSettingsNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const activeSection = resolveSettingsSectionFromSearch(location.search)
  const activeNav = resolveSettingsNavFromSearch(location.search)

  const setActiveNav = useCallback((nextNav) => {
    if (nextNav === activeNav) return false
    navigate(settingsPathForSection(nextNav))
    return true
  }, [activeNav, navigate])

  const setActiveSection = useCallback((nextSection) => {
    if (nextSection === activeSection) return false
    navigate(settingsPathForSection(nextSection))
    return true
  }, [activeSection, navigate])

  return {
    activeNav,
    activeSection,
    navigate,
    setActiveNav,
    setActiveSection,
  }
}
