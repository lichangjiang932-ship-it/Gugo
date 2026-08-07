export const SECRET_SENTINEL = '••••'

function fieldLabel(key) {
  return String(key || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function inferFieldType(key, secret) {
  const normalized = String(key || '').toLowerCase()
  if (secret || normalized.includes('secret') || normalized.includes('token') || normalized.includes('key')) return 'password'
  if (normalized === 'method' || normalized === 'language') return 'select'
  if (normalized.includes('url')) return 'url'
  return 'text'
}

function inferOptions(key) {
  const normalized = String(key || '').toLowerCase()
  if (normalized === 'method') return ['POST', 'GET']
  if (normalized === 'language') return ['zh', 'en', 'ja', 'ko', 'zh-TW']
  return []
}

export function normalizeFields(meta) {
  const fields = meta?.fields
  if (Array.isArray(fields)) return fields.map((field) => {
    const key = field.key || field.name || field.id
    const secret = field.secret || field.location === 'secret' || field.type === 'password'
    return { key, label: field.label || fieldLabel(key), type: field.type || inferFieldType(key, secret), location: secret ? 'secret' : 'config', options: field.options || inferOptions(key), optional: !!field.optional }
  }).filter((field) => field.key)
  const convert = (keys, location, optional) => (keys || []).map((key) => ({
    key, label: fieldLabel(key), type: location === 'secret' ? 'password' : inferFieldType(key, false), location,
    options: location === 'secret' ? [] : inferOptions(key), optional,
  }))
  return [
    ...convert(fields?.config, 'config', false), ...convert(fields?.secret, 'secret', false),
    ...convert(fields?.optional?.config, 'config', true), ...convert(fields?.optional?.secret, 'secret', true),
  ]
}

export function getLastTest(integration) {
  if (integration?.lastTest) return integration.lastTest
  if (!integration?.last_test_at) return null
  return { at: integration.last_test_at, ok: integration.last_test_ok, message: integration.last_test_message || '' }
}

export function formatTestTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export function emptyIntegrationForm(provider, meta) {
  return { id: '', provider, name: meta?.label || provider, enabled: true, config: {}, secret: {} }
}

export function formFromIntegration(integration, meta) {
  const secret = {}
  for (const field of normalizeFields(meta)) {
    if (field.location === 'secret' && integration.secret?.[field.key]?.present) secret[field.key] = SECRET_SENTINEL
  }
  return { id: integration.id, provider: integration.provider, name: integration.name || meta?.label || integration.provider, enabled: integration.enabled !== false, config: { ...(integration.config || {}) }, secret }
}
