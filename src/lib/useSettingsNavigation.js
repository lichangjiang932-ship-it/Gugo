import { useCallback, useMemo } from 'react'

import { useLocation, useNavigate } from './router.jsx'
import {
  resolveSettingsNavFromSearch,
  resolveSettingsSectionFromSearch,
  settingsPathForSection,
} from './settingsNavigation.js'
import { useUiContributions } from '../plugins/uiContributionRegistry.js'

export default function useSettingsNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const contributedSections = useUiContributions('settings-section')
  const allowedSections = useMemo(
    () => contributedSections.map((contribution) => contribution.sectionId),
    [contributedSections],
  )
  const activeSection = resolveSettingsSectionFromSearch(location.search, allowedSections)
  const activeNav = resolveSettingsNavFromSearch(location.search, allowedSections)

  const setActiveNav = useCallback((nextNav) => {
    if (nextNav === activeNav) return false
    navigate(settingsPathForSection(nextNav, allowedSections))
    return true
  }, [activeNav, allowedSections, navigate])

  const setActiveSection = useCallback((nextSection) => {
    if (nextSection === activeSection) return false
    navigate(settingsPathForSection(nextSection, allowedSections))
    return true
  }, [activeSection, allowedSections, navigate])

  return {
    activeNav,
    activeSection,
    navigate,
    setActiveNav,
    setActiveSection,
  }
}
