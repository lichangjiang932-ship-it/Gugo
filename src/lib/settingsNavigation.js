export const SETTINGS_TAB_FEATURES = '功能入口'
export const SETTINGS_TAB_ACCOUNT = '账户'
export const SETTINGS_TAB_MODELS = '模型'

export function settingsPathAfterLogin(user = null) {
  return user?.hasPassword === false
    ? '/settings?tab=account&setupPassword=1'
    : '/settings'
}

export function resolveSettingsNavFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search || '')
    const tab = params.get('tab')
    if (tab === 'account') return SETTINGS_TAB_ACCOUNT
    if (tab === 'models') return SETTINGS_TAB_MODELS
    return SETTINGS_TAB_FEATURES
  } catch {
    return SETTINGS_TAB_FEATURES
  }
}

export function shouldPromptPasswordSetup(search = '', user = null) {
  try {
    const params = new URLSearchParams(search || '')
    return params.get('setupPassword') === '1' && user?.hasPassword === false
  } catch {
    return false
  }
}
