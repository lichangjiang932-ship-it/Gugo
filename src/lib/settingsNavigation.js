export const SETTINGS_TAB_FEATURES = '功能入口'
export const SETTINGS_TAB_MODELS = '模型'
export const SETTINGS_TAB_WEB_SEARCH = 'web-search'

export function settingsPathAfterLogin() {
  return '/settings'
}

export function resolveSettingsNavFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search || '')
    const tab = params.get('tab')
    if (tab === 'models') return SETTINGS_TAB_MODELS
    if (tab === 'web-search') return SETTINGS_TAB_WEB_SEARCH
    return SETTINGS_TAB_FEATURES
  } catch {
    return SETTINGS_TAB_FEATURES
  }
}
