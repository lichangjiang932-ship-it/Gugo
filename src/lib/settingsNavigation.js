export const SETTINGS_TAB_FEATURES = 'features'
export const SETTINGS_TAB_MODELS = 'models'
export const SETTINGS_TAB_WEB_SEARCH = 'web-search'
export const SETTINGS_TAB_INTEGRATIONS = 'integrations'
export const SETTINGS_TAB_FILES = 'files'
export const SETTINGS_TAB_PERMISSIONS = 'permissions'
export const SETTINGS_TAB_APPEARANCE = 'appearance'
export const SETTINGS_TAB_LANGUAGE = 'language'
export const SETTINGS_TAB_PET = 'pet'
export const SETTINGS_TAB_DIAGNOSTICS = 'diagnostics'
export const SETTINGS_TAB_DATA = 'data'

const SETTINGS_SECTIONS = new Set([
  SETTINGS_TAB_FEATURES,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_WEB_SEARCH,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_FILES,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_PET,
  SETTINGS_TAB_DIAGNOSTICS,
  SETTINGS_TAB_DATA,
])

export function settingsPathAfterLogin() {
  return '/settings'
}

export function resolveSettingsSectionFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search || '')
    const tab = params.get('tab')
    return SETTINGS_SECTIONS.has(tab) ? tab : SETTINGS_TAB_FEATURES
  } catch {
    return SETTINGS_TAB_FEATURES
  }
}

export function resolveSettingsNavFromSearch(search = '') {
  return resolveSettingsSectionFromSearch(search)
}

export function defaultSettingsSection(section) {
  return SETTINGS_SECTIONS.has(section) ? section : SETTINGS_TAB_FEATURES
}

export function settingsPathForSection(section) {
  const resolved = SETTINGS_SECTIONS.has(section) ? section : SETTINGS_TAB_FEATURES
  return resolved === SETTINGS_TAB_FEATURES ? '/settings' : `/settings?tab=${encodeURIComponent(resolved)}`
}
