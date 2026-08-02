import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const VAULT_VERSION = 1
const VAULT_MARKER = '__yma_credential_vault'
const KEY_BYTES = 32
const keyCache = new Map()

function vaultError(message, code = 'CREDENTIAL_VAULT_ERROR', cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = 500
  return error
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function parseKey(value) {
  const raw = String(value || '').trim()
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  const unprefixed = raw.replace(/^base64:/i, '')
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(unprefixed)) {
    throw vaultError('Credential encryption key must be 32 bytes encoded as hex or base64', 'CREDENTIAL_VAULT_KEY_INVALID')
  }
  const normalized = unprefixed.replace(/-/g, '+').replace(/_/g, '/')
  const key = Buffer.from(normalized, 'base64')
  if (key.length !== KEY_BYTES) {
    throw vaultError('Credential encryption key must be exactly 32 bytes', 'CREDENTIAL_VAULT_KEY_INVALID')
  }
  return key
}

function defaultKeyPath(env) {
  if (env.CREDENTIAL_KEY_PATH) return path.resolve(String(env.CREDENTIAL_KEY_PATH))
  if (env.APP_DB_PATH) return path.join(path.dirname(path.resolve(String(env.APP_DB_PATH))), '.credentials.key')
  const dataDir = env.APP_DATA_DIR
    ? path.resolve(String(env.APP_DATA_DIR))
    : path.join(process.cwd(), 'server-data')
  return path.join(dataDir, '.credentials.key')
}

function readKeyFile(keyPath) {
  try {
    return parseKey(fs.readFileSync(keyPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'CREDENTIAL_VAULT_KEY_INVALID') throw error
    throw vaultError('Unable to read the credential encryption key', 'CREDENTIAL_VAULT_KEY_UNAVAILABLE', error)
  }
}

function loadVaultKey(env = process.env) {
  const configured = String(env.CREDENTIAL_ENCRYPTION_KEY || '').trim()
  if (configured) {
    const cacheId = `env:${crypto.createHash('sha256').update(configured).digest('hex')}`
    if (!keyCache.has(cacheId)) keyCache.set(cacheId, parseKey(configured))
    return keyCache.get(cacheId)
  }

  const keyPath = defaultKeyPath(env)
  const cacheId = `file:${keyPath}`
  if (keyCache.has(cacheId)) return keyCache.get(cacheId)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  if (!fs.existsSync(keyPath)) {
    const generated = crypto.randomBytes(KEY_BYTES).toString('base64')
    try {
      fs.writeFileSync(keyPath, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw vaultError('Unable to create the credential encryption key', 'CREDENTIAL_VAULT_KEY_UNAVAILABLE', error)
      }
    }
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(keyPath, 0o600) } catch { /* read remains the authority */ }
  }
  const key = readKeyFile(keyPath)
  keyCache.set(cacheId, key)
  return key
}

function resolveKey(key, env) {
  if (key === undefined) return loadVaultKey(env)
  if (Buffer.isBuffer(key) && key.length === KEY_BYTES) return key
  if (key instanceof Uint8Array && key.byteLength === KEY_BYTES) return Buffer.from(key)
  return parseKey(key)
}

function additionalData(purpose) {
  return Buffer.from(`your-model-atelier:credential-vault:v${VAULT_VERSION}:${purpose}`, 'utf8')
}

export function sealCredentialObject(value, {
  purpose,
  key,
  env = process.env,
} = {}) {
  const safePurpose = String(purpose || '').trim()
  if (!safePurpose) throw vaultError('Credential encryption purpose is required', 'CREDENTIAL_VAULT_PURPOSE_REQUIRED')
  const vaultKey = resolveKey(key, env)
  let plaintext
  try {
    plaintext = JSON.stringify(value ?? {})
  } catch (error) {
    throw vaultError('Credential value is not serializable', 'CREDENTIAL_VAULT_SERIALIZE_FAILED', error)
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv)
  cipher.setAAD(additionalData(safePurpose))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope = {
    [VAULT_MARKER]: VAULT_VERSION,
    alg: 'A256GCM',
    purpose: safePurpose,
    kid: keyFingerprint(vaultKey),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url'),
  }
  return JSON.stringify(envelope)
}

export function openCredentialObject(serialized, {
  purpose,
  key,
  env = process.env,
  legacyDecoder,
} = {}) {
  const raw = String(serialized || '')
  let envelope
  try { envelope = JSON.parse(raw) } catch { envelope = null }
  if (!envelope || envelope[VAULT_MARKER] !== VAULT_VERSION) {
    let value
    try {
      value = legacyDecoder ? legacyDecoder(raw) : (envelope && typeof envelope === 'object' ? envelope : {})
    } catch {
      value = {}
    }
    return { value: value && typeof value === 'object' ? value : {}, legacy: true }
  }

  const safePurpose = String(purpose || '').trim()
  if (!safePurpose || envelope.purpose !== safePurpose || envelope.alg !== 'A256GCM') {
    throw vaultError('Credential envelope purpose or algorithm is invalid', 'CREDENTIAL_VAULT_ENVELOPE_INVALID')
  }
  const vaultKey = resolveKey(key, env)
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      vaultKey,
      Buffer.from(String(envelope.iv || ''), 'base64url'),
    )
    decipher.setAAD(additionalData(safePurpose))
    decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.data || ''), 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    const value = JSON.parse(plaintext)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('credential payload must be an object')
    }
    return { value, legacy: false }
  } catch (error) {
    throw vaultError('Credential data could not be authenticated or decrypted', 'CREDENTIAL_VAULT_DECRYPT_FAILED', error)
  }
}

export function isCredentialEnvelope(serialized) {
  try {
    return JSON.parse(String(serialized || ''))?.[VAULT_MARKER] === VAULT_VERSION
  } catch {
    return false
  }
}

export function credentialKeyPath(env = process.env) {
  return defaultKeyPath(env)
}
