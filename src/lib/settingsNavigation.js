export const SETTINGS_PAGE_FEATURES = 'features'
export const SETTINGS_PAGE_MODEL_SEARCH = 'model-search'
export const SETTINGS_PAGE_FILES_PERMISSIONS = 'files-permissions'
export const SETTINGS_PAGE_APPEARANCE_LANGUAGE = 'appearance-language'
export const SETTINGS_PAGE_SYSTEM_DATA = 'system-data'

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

const TAB_TO_PAGE = Object.freeze({
  [SETTINGS_TAB_FEATURES]: SETTINGS_PAGE_FEATURES,
  [SETTINGS_TAB_MODELS]: SETTINGS_PAGE_MODEL_SEARCH,
  [SETTINGS_TAB_WEB_SEARCH]: SETTINGS_PAGE_MODEL_SEARCH,
  [SETTINGS_TAB_INTEGRATIONS]: SETTINGS_PAGE_MODEL_SEARCH,
  [SETTINGS_TAB_FILES]: SETTINGS_PAGE_FILES_PERMISSIONS,
  [SETTINGS_TAB_PERMISSIONS]: SETTINGS_PAGE_FILES_PERMISSIONS,
  [SETTINGS_TAB_APPEARANCE]: SETTINGS_PAGE_APPEARANCE_LANGUAGE,
  [SETTINGS_TAB_LANGUAGE]: SETTINGS_PAGE_APPEARANCE_LANGUAGE,
  [SETTINGS_TAB_PET]: SETTINGS_PAGE_APPEARANCE_LANGUAGE,
  [SETTINGS_TAB_DIAGNOSTICS]: SETTINGS_PAGE_SYSTEM_DATA,
  [SETTINGS_TAB_DATA]: SETTINGS_PAGE_SYSTEM_DATA,
})

const DEFAULT_TAB_BY_PAGE = Object.freeze({
  [SETTINGS_PAGE_FEATURES]: SETTINGS_TAB_FEATURES,
  [SETTINGS_PAGE_MODEL_SEARCH]: SETTINGS_TAB_MODELS,
  [SETTINGS_PAGE_FILES_PERMISSIONS]: SETTINGS_TAB_FILES,
  [SETTINGS_PAGE_APPEARANCE_LANGUAGE]: SETTINGS_TAB_APPEARANCE,
  [SETTINGS_PAGE_SYSTEM_DATA]: SETTINGS_TAB_DIAGNOSTICS,
})

export function settingsPathAfterLogin() {
  return '/settings'
}

export function resolveSettingsSectionFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search || '')
    const tab = params.get('tab')
    return TAB_TO_PAGE[tab] ? tab : SETTINGS_TAB_FEATURES
  } catch {
    return SETTINGS_TAB_FEATURES
  }
}

export function resolveSettingsNavFromSearch(search = '') {
  return TAB_TO_PAGE[resolveSettingsSectionFromSearch(search)] || SETTINGS_PAGE_FEATURES
}

export function defaultSettingsSection(page) {
  return DEFAULT_TAB_BY_PAGE[page] || SETTINGS_TAB_FEATURES
}

export function settingsPathForSection(section) {
  const resolved = TAB_TO_PAGE[section] ? section : SETTINGS_TAB_FEATURES
  return resolved === SETTINGS_TAB_FEATURES ? '/settings' : `/settings?tab=${encodeURIComponent(resolved)}`
}
