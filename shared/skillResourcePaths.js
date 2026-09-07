/** Logical package paths only; never interpret these as operating-system paths. */
export function normalizeSkillResourcePath(value, { maxLength = 240 } = {}) {
  if (typeof value !== 'string' || !value || value.length > maxLength) return null
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value)) return null
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}
