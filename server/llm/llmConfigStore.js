import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

/**
 * The two configuration files, and the rules that keep them apart.
 *
 * settings.yaml is the only hand-written source: providers, models, the default
 * model. .credentials.yaml holds keys and nothing else, mode 0600, and is never
 * echoed back — the UI reads a descriptor (`sk-••••abcd`), not a value. Reading
 * a key prefers the environment variable a provider names, so a deployment can
 * keep keys out of files entirely.
 */
export const SETTINGS_FILE = 'settings.yaml'
export const CREDENTIALS_FILE = '.credentials.yaml'
export const LLM_SETTINGS_NAMESPACE = 'llm'
export const REDACTED_VALUE = '••••••'

export function resolveGugoHome(env = process.env) {
  const configured = String(env.GUGO_HOME || '').trim()
  return configured || join(homedir(), '.gugo')
}

export function settingsPath(env = process.env) {
  return join(resolveGugoHome(env), SETTINGS_FILE)
}

export function credentialsPath(env = process.env) {
  return join(resolveGugoHome(env), CREDENTIALS_FILE)
}

// Model resolution reads these files on every request, so a parsed document is
// reused until the file's mtime changes — the same rule the UI's hot reload
// relies on, without a stat storm per call.
const yamlCache = new Map()

function readYaml(path) {
  if (!existsSync(path)) {
    yamlCache.delete(path)
    return {}
  }
  const { mtimeMs } = statSync(path)
  const cached = yamlCache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.value
  const parsed = yaml.load(readFileSync(path, 'utf8'))
  const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  yamlCache.set(path, { mtimeMs, value })
  return value
}

function writeYaml(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, yaml.dump(value, { lineWidth: 120, noRefs: true }), 'utf8')
  renameSync(temporary, path)
}

export function readSettings(env = process.env) {
  return readYaml(settingsPath(env))
}

export function writeSettings(next, env = process.env) {
  const path = settingsPath(env)
  writeYaml(path, next)
  yamlCache.set(path, { mtimeMs: statSync(path).mtimeMs, value: next })
  return next
}

function harden(path) {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX mode; ACLs there are the platform's business.
  }
}

export function readCredentials(env = process.env) {
  return readYaml(credentialsPath(env))
}

export function writeCredentials(next, env = process.env) {
  const path = credentialsPath(env)
  writeYaml(path, next)
  harden(path)
  yamlCache.set(path, { mtimeMs: statSync(path).mtimeMs, value: next })
  return next
}

/** What the UI may see: a shape, never the secret. */
export function credentialDescriptor(apiKey) {
  const value = String(apiKey || '')
  if (!value) return ''
  if (value.length <= 8) return REDACTED_VALUE
  return `${value.slice(0, 3)}${REDACTED_VALUE}${value.slice(-4)}`
}

export function providersFromSettings(settings = {}) {
  const providers = settings?.[LLM_SETTINGS_NAMESPACE]?.providers
  return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
}

export function readDefaultModel(settings = {}) {
  const entry = settings?.['agent-default-model']
  if (!entry || typeof entry !== 'object') return { provider: '', model: '' }
  return { provider: String(entry.provider || ''), model: String(entry.model || '') }
}

/** env beats file: a deployment that exports the key never needs the secret on disk. */
export function resolveApiKey(providerId, providerConfig = {}, { env = process.env, credentials = readCredentials(env) } = {}) {
  const envName = String(providerConfig.apiKeyEnv || '').trim()
  const fromEnv = envName ? String(env?.[envName] || '').trim() : ''
  if (fromEnv) return { apiKey: fromEnv, source: 'env' }
  const stored = credentials?.providers?.[providerId]?.apiKey
  const value = String(stored || '').trim()
  return value ? { apiKey: value, source: 'credentials' } : { apiKey: '', source: 'none' }
}

/** Last line of defence for logs and error strings. */
export function redactSecrets(text, secrets = []) {
  let output = String(text ?? '')
  for (const secret of secrets) {
    const value = String(secret || '').trim()
    if (value.length < 8) continue
    output = output.split(value).join(REDACTED_VALUE)
  }
  return output
}

export function allStoredSecrets(credentials = {}) {
  return Object.values(credentials?.providers || {})
    .map((entry) => entry?.apiKey)
    .filter((value) => typeof value === 'string' && value.trim())
}
