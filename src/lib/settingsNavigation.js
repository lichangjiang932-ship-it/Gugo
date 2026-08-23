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
export const SETTINGS_TAB_RECOVERY = 'recovery'
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
  SETTINGS_TAB_RECOVERY,
  SETTINGS_TAB_ABOUT,
])

const LEGACY_SECTION_ALIASES = new Map([
  [SETTINGS_TAB_FEATURES, SETTINGS_TAB_GENERAL],
  [SETTINGS_TAB_FILES, SETTINGS_TAB_GENERAL],
  [SETTINGS_TAB_PET, SETTINGS_TAB_GENERAL],
  [SETTINGS_TAB_DIAGNOSTICS, SETTINGS_TAB_ABOUT],
])

const SAFE_SETTINGS_RETURN_PATHS = new Set(['/chat'])
const SAFE_TASK_RETURN_PATHS = new Set(['/task', '/tasks'])
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
function hasUnsafeReturnCharacters(value) {
  if (value.includes('\\')) return true
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function canonicalSettingsSection(section, allowedSections = []) {
  const canonical = LEGACY_SECTION_ALIASES.get(section) || section
  const contributed = new Set(Array.isArray(allowedSections) ? allowedSections : [])
  return SETTINGS_SECTIONS.has(canonical) || contributed.has(canonical) ? canonical : SETTINGS_TAB_GENERAL
}

export function settingsPathAfterLogin() {
  return '/settings'
}

export function normalizeSettingsReturnTo(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512) return ''
  if (hasUnsafeReturnCharacters(value) || !value.startsWith('/') || value.startsWith('//')) return ''
  if (SAFE_SETTINGS_RETURN_PATHS.has(value)) return value

  let target
  try {
    target = new URL(value, 'https://gugo.local')
  } catch {
    return ''
  }
  if (target.origin !== 'https://gugo.local' || target.hash || !SAFE_TASK_RETURN_PATHS.has(target.pathname)) return ''
  if (!target.search) return target.pathname
  const keys = [...target.searchParams.keys()]
  const jobs = target.searchParams.getAll('job')
  if (keys.length !== 1 || keys[0] !== 'job' || jobs.length !== 1 || !SAFE_JOB_ID.test(jobs[0])) return ''
  return `${target.pathname}?${new URLSearchParams({ job: jobs[0] })}`
}

export function resolveSettingsReturnToFromSearch(search = '') {
  try {
    const params = new URLSearchParams(search || '')
    const values = params.getAll('returnTo')
    return values.length === 1 ? normalizeSettingsReturnTo(values[0]) : ''
  } catch {
    return ''
  }
}

export function resolveSettingsSectionFromSearch(search = '', allowedSections = []) {
  try {
    const params = new URLSearchParams(search || '')
    return canonicalSettingsSection(params.get('tab'), allowedSections)
  } catch {
    return SETTINGS_TAB_GENERAL
  }
}

export function resolveSettingsNavFromSearch(search = '', allowedSections = []) {
  return resolveSettingsSectionFromSearch(search, allowedSections)
}

export function defaultSettingsSection(section, allowedSections = []) {
  return canonicalSettingsSection(section, allowedSections)
}

export function settingsPathForSection(section, allowedSections = [], { returnTo = '' } = {}) {
  const params = new URLSearchParams()
  if ([SETTINGS_TAB_FILES, SETTINGS_TAB_PET, SETTINGS_TAB_DIAGNOSTICS].includes(section)) {
    params.set('tab', section)
  } else {
    const resolved = canonicalSettingsSection(section, allowedSections)
    if (resolved !== SETTINGS_TAB_GENERAL) params.set('tab', resolved)
  }
  const safeReturnTo = normalizeSettingsReturnTo(returnTo)
  if (safeReturnTo) params.set('returnTo', safeReturnTo)
  const query = params.toString()
  return `/settings${query ? `?${query}` : ''}`
}
