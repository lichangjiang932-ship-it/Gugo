export const SETTINGS_TAB_GENERAL = 'general'
export const SETTINGS_TAB_MODELS = 'models'
export const SETTINGS_TAB_APPEARANCE = 'appearance'
export const SETTINGS_TAB_LANGUAGE = 'language'
export const SETTINGS_TAB_PLUGINS = 'plugins'
export const SETTINGS_TAB_WEB_SEARCH = 'web-search'
export const SETTINGS_TAB_PERMISSIONS = 'permissions'
export const SETTINGS_TAB_AGENT_PRESETS = 'agent-presets'
export const SETTINGS_TAB_INTEGRATIONS = 'integrations'
export const SETTINGS_TAB_DATA = 'data'
export const SETTINGS_TAB_ABOUT = 'about'

// Retained for old bookmarks and internal links created before grouped settings.
export const SETTINGS_TAB_FEATURES = 'features'
export const SETTINGS_TAB_FILES = 'files'
export const SETTINGS_TAB_PET = 'pet'
export const SETTINGS_TAB_DIAGNOSTICS = 'diagnostics'

const SETTINGS_SECTIONS = new Set([
  SETTINGS_TAB_GENERAL,
  SETTINGS_TAB_MODELS,
  SETTINGS_TAB_APPEARANCE,
  SETTINGS_TAB_LANGUAGE,
  SETTINGS_TAB_PLUGINS,
  SETTINGS_TAB_WEB_SEARCH,
  SETTINGS_TAB_PERMISSIONS,
  SETTINGS_TAB_AGENT_PRESETS,
  SETTINGS_TAB_INTEGRATIONS,
  SETTINGS_TAB_DATA,
  SETTINGS_TAB_ABOUT,
])

const LEGACY_SECTION_ALIASES = new Map([
  [SETTINGS_TAB_FEATURES, SETTINGS_TAB_GENERAL],
  [SETTINGS_TAB_FILES, SETTINGS_TAB_GENERAL],
  [SETTINGS_TAB_PET, SETTINGS_TAB_GENERAL],
  [SETTINGS_TAB_DIAGNOSTICS, SETTINGS_TAB_ABOUT],
])

function canonicalSettingsSection(section) {
  const canonical = LEGACY_SECTION_ALIASES.get(section) || section
  return SETTINGS_SECTIONS.has(canonical) ? canonical : SETTINGS_TAB_GENERAL
}

export function settingsPathAfterLogin() {
  return '/settings'
}

export function resolveSettingsSectionFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search || '')
    return canonicalSettingsSection(params.get('tab'))
  } catch {
    return SETTINGS_TAB_GENERAL
  }
}

export function resolveSettingsNavFromSearch(search = '') {
  return resolveSettingsSectionFromSearch(search)
}

export function defaultSettingsSection(section) {
  return canonicalSettingsSection(section)
}

export function settingsPathForSection(section) {
  if ([SETTINGS_TAB_FILES, SETTINGS_TAB_PET, SETTINGS_TAB_DIAGNOSTICS].includes(section)) {
    return `/settings?tab=${encodeURIComponent(section)}`
  }
  const resolved = canonicalSettingsSection(section)
  return resolved === SETTINGS_TAB_GENERAL ? '/settings' : `/settings?tab=${encodeURIComponent(resolved)}`
}
