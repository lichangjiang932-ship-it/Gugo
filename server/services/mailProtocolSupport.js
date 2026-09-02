import crypto from 'node:crypto'

export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_OPERATION_TIMEOUT_MS = 45_000
export const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024
export const MAX_MESSAGE_BYTES = 512 * 1024
export const MAX_SEND_BYTES = 2 * 1024 * 1024
export const MAX_LIST_RESULT_BYTES = 256 * 1024

const QQ_SMTP_HOST = 'smtp.qq.com'
const QQ_IMAP_HOST = 'imap.qq.com'
const QQ_SMTP_PORTS = new Set([465, 587])
const QQ_IMAP_PORT = 993
const MAIL_PROVIDER_PRESETS = Object.freeze({
  qq_mail: { smtpHost: QQ_SMTP_HOST, smtpPort: 465, imapHost: QQ_IMAP_HOST, imapPort: 993 },
  gmail: { smtpHost: 'smtp.gmail.com', smtpPort: 465, imapHost: 'imap.gmail.com', imapPort: 993 },
  outlook: { smtpHost: 'smtp.office365.com', smtpPort: 587, imapHost: 'outlook.office365.com', imapPort: 993 },
  exchange: { smtpPort: 587, imapPort: 993 },
  custom_mail: { smtpPort: 465, imapPort: 993 },
})

export function mailError(message, statusCode = 400, code = 'MAIL_CONNECTOR_ERROR') {
  return Object.assign(new Error(message), { statusCode, code })
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function hasAsciiControl(value, { includeSpace = false } = {}) {
  const text = String(value ?? '')
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 127 || code < 32 || (includeSpace && code === 32)) return true
  }
  return false
}

function parsePort(value, fallback, label) {
  const port = Number(firstValue(value, fallback))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw mailError(`${label} must be an integer between 1 and 65535`)
  }
  return port
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function allowQqMailEnvCredentials(env = process.env) {
  const mode = String(env?.AUTH_MODE || 'local').trim().toLowerCase()
  return !mode || mode === 'local'
}

function validateHost(value, label) {
  const host = String(value ?? '').trim()
  if (!host || host.length > 253 || hasAsciiControl(host, { includeSpace: true }) || /[/@?#\\]/.test(host)) {
    throw mailError(`${label} is invalid`)
  }
  return host
}

export function validateEmail(value, label = 'email') {
  const email = String(value ?? '').trim()
  const parts = email.split('@')
  const local = parts[0] || ''
  const domain = parts[1] || ''
  const domainLabels = domain.split('.')
  const validDomain = domainLabels.length >= 2 && domainLabels.every((part) => (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part)
  ))
  if (
    !email
    || email.length > 320
    || parts.length !== 2
    || local.length > 64
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || hasAsciiControl(email, { includeSpace: true })
    || [...'<>()[]\\,;:"'].some((character) => email.includes(character))
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || !validDomain
  ) {
    throw mailError(`${label} is invalid`)
  }
  return email
}

export function safeErrorMessage(error, sensitiveValues = []) {
  let value = cleanText(error?.message || error || 'connection failed', 300).replace(/[\r\n\t]+/g, ' ')
  for (const sensitiveValue of sensitiveValues) {
    const secret = String(sensitiveValue || '')
    if (!secret) continue
    value = value.split(secret).join('[redacted]')
    value = value.split(Buffer.from(secret).toString('base64')).join('[redacted]')
  }
  return value
}

export function resolveQqMailSettings({
  config = {},
  secret = {},
  env = process.env,
  allowEnvCredentials = false,
} = {}) {
  const credentialEnv = allowEnvCredentials ? env : {}
  const smtpPort = parsePort(firstValue(config.smtpPort, config.port, credentialEnv.MAIL_PORT), 465, 'SMTP port')
  const imapPort = parsePort(firstValue(config.imapPort, credentialEnv.MAIL_IMAP_PORT), QQ_IMAP_PORT, 'IMAP port')
  if (!QQ_SMTP_PORTS.has(smtpPort)) throw mailError('QQ Mail SMTP port must be 465 or 587')
  if (imapPort !== QQ_IMAP_PORT) throw mailError('QQ Mail IMAP port must be 993')

  const user = validateEmail(firstValue(
    config.user,
    config.account,
    credentialEnv.MAIL_USER,
    credentialEnv.MAIL_USERNAME,
  ), 'MAIL_USER')
  const password = String(firstValue(
    secret.password,
    secret.authorizationCode,
    credentialEnv.MAIL_PASSWORD,
  ) || '')
  if (!password) throw mailError('MAIL_PASSWORD is required (use the QQ Mail authorization code)')
  if (password.length > 512 || hasAsciiControl(password)) {
    throw mailError('MAIL_PASSWORD is invalid')
  }
  const smtpHost = validateHost(firstValue(
    config.smtpHost,
    config.host,
    credentialEnv.MAIL_HOST,
    credentialEnv.MAIL_SERVER,
    QQ_SMTP_HOST,
  ), 'SMTP host').toLowerCase()
  const imapHost = validateHost(firstValue(
    config.imapHost,
    credentialEnv.MAIL_IMAP_HOST,
    QQ_IMAP_HOST,
  ), 'IMAP host').toLowerCase()
  if (smtpHost !== QQ_SMTP_HOST) throw mailError(`QQ Mail SMTP host must be ${QQ_SMTP_HOST}`)
  if (imapHost !== QQ_IMAP_HOST) throw mailError(`QQ Mail IMAP host must be ${QQ_IMAP_HOST}`)

  const from = validateEmail(firstValue(
    config.from,
    credentialEnv.MAIL_FROM,
    credentialEnv.MAIL_DEFAULT_SENDER,
    user,
  ), 'MAIL_FROM')
  if (from.toLowerCase() !== user.toLowerCase()) {
    throw mailError('MAIL_FROM must match MAIL_USER')
  }
  const smtpSecure = smtpPort === 465
  const smtpStartTls = smtpPort === 587
  const imapSecure = true
  if (config.smtpSecure !== undefined && parseBoolean(config.smtpSecure, smtpSecure) !== smtpSecure) {
    throw mailError(`QQ Mail SMTP port ${smtpPort} requires ${smtpSecure ? 'implicit TLS' : 'STARTTLS'}`)
  }
  if (config.smtpStartTls !== undefined && parseBoolean(config.smtpStartTls, smtpStartTls) !== smtpStartTls) {
    throw mailError(`QQ Mail SMTP port ${smtpPort} requires ${smtpStartTls ? 'STARTTLS' : 'implicit TLS'}`)
  }
  if (config.imapSecure !== undefined && !parseBoolean(config.imapSecure, true)) {
    throw mailError('QQ Mail IMAP requires TLS')
  }
  return {
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpStartTls,
    imapHost,
    imapPort,
    imapSecure,
    user,
    password,
    from,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
  }
}

export function resolveMailSettings({
  provider = 'custom_mail',
  config = {},
  secret = {},
  env = process.env,
  allowEnvCredentials = false,
} = {}) {
  if (provider === 'qq_mail') {
    return resolveQqMailSettings({ config, secret, env, allowEnvCredentials })
  }
  const preset = MAIL_PROVIDER_PRESETS[provider] || MAIL_PROVIDER_PRESETS.custom_mail
  const credentialEnv = allowEnvCredentials ? env : {}
  const smtpHost = validateHost(firstValue(
    config.smtpHost, config.host, credentialEnv.MAIL_HOST, credentialEnv.MAIL_SERVER, preset.smtpHost,
  ), 'SMTP host').toLowerCase()
  const imapHost = validateHost(firstValue(
    config.imapHost, credentialEnv.MAIL_IMAP_HOST, preset.imapHost,
  ), 'IMAP host').toLowerCase()
  const smtpPort = parsePort(firstValue(config.smtpPort, config.port, credentialEnv.MAIL_PORT), preset.smtpPort, 'SMTP port')
  const imapPort = parsePort(firstValue(config.imapPort, credentialEnv.MAIL_IMAP_PORT), preset.imapPort, 'IMAP port')
  const user = validateEmail(firstValue(
    config.user, config.account, credentialEnv.MAIL_USER, credentialEnv.MAIL_USERNAME,
  ), 'MAIL_USER')
  const password = String(firstValue(
    secret.password, secret.authorizationCode, credentialEnv.MAIL_PASSWORD,
  ) || '')
  if (!password) throw mailError('MAIL_PASSWORD is required (use an app password when the provider requires one)')
  if (password.length > 512 || hasAsciiControl(password)) throw mailError('MAIL_PASSWORD is invalid')
  const from = validateEmail(firstValue(
    config.from, credentialEnv.MAIL_FROM, credentialEnv.MAIL_DEFAULT_SENDER, user,
  ), 'MAIL_FROM')
  const smtpSecure = parseBoolean(config.smtpSecure, smtpPort === 465)
  const smtpStartTls = parseBoolean(config.smtpStartTls, !smtpSecure && smtpPort === 587)
  const imapSecure = parseBoolean(config.imapSecure, imapPort === 993)
  if (!smtpSecure && !smtpStartTls) throw mailError('SMTP must use implicit TLS or STARTTLS')
  if (!imapSecure) throw mailError('IMAP must use TLS')
  return {
    provider,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpStartTls,
    imapHost,
    imapPort,
    imapSecure,
    user,
    password,
    from,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    operationTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
  }
}

export function assertHeader(value, label, maxLength = 998) {
  const text = String(value ?? '').trim()
  if (hasAsciiControl(text) || text.length > maxLength) throw mailError(`${label} is invalid`)
  return text
}

function encodeHeader(value) {
  const text = assertHeader(value, 'header')
  return /[^\x20-\x7e]/.test(text) ? `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=` : text
}

function normalizeBody(value) {
  return String(value ?? '').replace(/\r?\n/g, '\r\n')
}

export function buildMimeMessage({ from, to, subject, text, html }) {
  const plain = normalizeBody(text)
  const rich = html == null ? '' : normalizeBody(html)
  if (!plain && !rich) throw mailError('message text or html is required')
  if (Buffer.byteLength(plain) + Buffer.byteLength(rich) > MAX_SEND_BYTES) {
    throw mailError(`message exceeds ${MAX_SEND_BYTES} bytes`, 413, 'MAIL_MESSAGE_TOO_LARGE')
  }
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject || '(no subject)')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@gugo.local>`,
    'MIME-Version: 1.0',
  ]
  if (!rich) {
    return [...headers, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', plain].join('\r\n')
  }
  const boundary = `gugo-${crypto.randomUUID()}`
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plain,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    rich,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

function decodeBytes(buffer, charset = 'utf-8') {
  try { return new TextDecoder(charset).decode(buffer) } catch { return buffer.toString('utf8') }
}

function decodeQuotedPrintable(value, charset = 'utf-8') {
  const unfolded = String(value).replace(/=\r?\n/g, '')
  const bytes = []
  for (let index = 0; index < unfolded.length; index += 1) {
    const hex = unfolded.slice(index + 1, index + 3)
    if (unfolded[index] === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      index += 2
    } else {
      bytes.push(unfolded.charCodeAt(index) & 0xff)
    }
  }
  return decodeBytes(Buffer.from(bytes), charset)
}

export function decodeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset, encoding, encoded) => {
    try {
      if (encoding.toLowerCase() === 'b') return decodeBytes(Buffer.from(encoded, 'base64'), charset)
      return decodeQuotedPrintable(encoded.replace(/_/g, ' '), charset)
    } catch {
      return encoded
    }
  })
}

export function parseHeaders(rawHeaders) {
  const values = {}
  const unfolded = String(rawHeaders).replace(/\r?\n[\t ]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = decodeHeader(line.slice(separator + 1).trim())
    values[key] = values[key] ? `${values[key]}, ${value}` : value
  }
  return values
}

export function splitHeaderBody(raw) {
  const match = /\r?\n\r?\n/.exec(raw)
  if (!match) return { headers: parseHeaders(raw), body: '' }
  return {
    headers: parseHeaders(raw.slice(0, match.index)),
    body: raw.slice(match.index + match[0].length),
  }
}

function contentTypeParts(value) {
  const input = String(value || 'text/plain')
  const type = cleanText(input.split(';')[0], 100).toLowerCase()
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(input)?.[1] || 'utf-8'
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(input)
  return { type, charset, boundary: boundary?.[1] || boundary?.[2] || '' }
}

function decodeTransferBody(body, encoding, charset) {
  const normalized = cleanText(encoding, 50).toLowerCase()
  if (normalized === 'base64') return decodeBytes(Buffer.from(String(body).replace(/\s/g, ''), 'base64'), charset)
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body, charset)
  return String(body)
}

export function decodeMimeEntity(raw, depth = 0) {
  if (depth > 5) return { text: '', html: '' }
  const { headers, body } = splitHeaderBody(raw)
  const contentType = contentTypeParts(headers['content-type'])
  if (contentType.type.startsWith('multipart/') && contentType.boundary) {
    const marker = `--${contentType.boundary}`
    const parts = body.split(marker).slice(1).filter((part) => !part.startsWith('--'))
    const decoded = parts.map((part) => decodeMimeEntity(part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), depth + 1))
    return {
      text: decoded.map((part) => part.text).filter(Boolean).join('\n').slice(0, MAX_MESSAGE_BYTES),
      html: decoded.map((part) => part.html).filter(Boolean).join('\n').slice(0, MAX_MESSAGE_BYTES),
    }
  }
  if (/attachment/i.test(headers['content-disposition'] || '')) return { text: '', html: '' }
  const content = decodeTransferBody(body, headers['content-transfer-encoding'], contentType.charset).slice(0, MAX_MESSAGE_BYTES)
  if (contentType.type === 'text/html') return { text: '', html: content }
  if (contentType.type === 'text/plain' || !contentType.type) return { text: content, html: '' }
  return { text: '', html: '' }
}
