export const THEME_MODES = Object.freeze(['system', 'light', 'white', 'dark'])

export const THEME_OPTIONS = Object.freeze([
  Object.freeze({ key: 'dark', labelKey: 'settings.themeDark' }),
  Object.freeze({ key: 'light', labelKey: 'settings.themeLight' }),
  Object.freeze({ key: 'white', labelKey: 'settings.themeWhite' }),
  Object.freeze({ key: 'system', labelKey: 'settings.themeSystem' }),
])

const THEME_MODE_SET = new Set(THEME_MODES)

export function isThemeMode(value) {
  return typeof value === 'string' && THEME_MODE_SET.has(value)
}

export function normalizeThemeMode(value, fallback = 'white') {
  return isThemeMode(value) ? value : (isThemeMode(fallback) ? fallback : 'white')
}
