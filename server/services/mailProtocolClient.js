import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { pinnedLookup, resolvePublicHost } from '../utils/outboundNetworkGuard.js'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_OPERATION_TIMEOUT_MS = 45_000
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024
const MAX_MESSAGE_BYTES = 512 * 1024
const MAX_SEND_BYTES = 2 * 1024 * 1024
const MAX_LIST_RESULT_BYTES = 256 * 1024
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

function mailError(message, statusCode = 400, code = 'MAIL_CONNECTOR_ERROR') {
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

function validateEmail(value, label = 'email') {
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

function safeErrorMessage(error, sensitiveValues = []) {
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

function waitForSocket(socket, eventName, timeoutMs) {
  if ((eventName === 'connect' && !socket.connecting) || (eventName === 'secureConnect' && socket.authorized)) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(mailError('Mail server connection timed out', 504, 'MAIL_TIMEOUT')), timeoutMs)
    const onReady = () => finish()
    const onError = (error) => finish(error)
    const finish = (error) => {
      clearTimeout(timer)
      socket.off(eventName, onReady)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    socket.once(eventName, onReady)
    socket.once('error', onError)
  })
}

async function openSocket({ host, port, secure, timeoutMs }, dependencies = {}) {
  const tlsConnect = dependencies.tlsConnect || tls.connect
  const netConnect = dependencies.netConnect || net.connect
  const { lockedIp } = await resolvePublicHost(host, { lookup: dependencies.lookupHost })
  const lookup = pinnedLookup(lockedIp)
  const socket = secure
    ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true, lookup })
    : netConnect({ host, port, lookup })
  try {
    await waitForSocket(socket, secure ? 'secureConnect' : 'connect', timeoutMs)
  } catch (error) {
    socket.destroy?.()
    throw error
  }
  socket.setTimeout?.(timeoutMs)
  return socket
}

function createResponseReader(socket, { timeoutMs, maxBytes = MAX_PROTOCOL_BYTES } = {}) {
  let buffer = Buffer.alloc(0)
  let pending = null
  let terminalError = null

  const finishPending = (error, response, consumed = 0) => {
    if (!pending) return
    const current = pending
    pending = null
    clearTimeout(current.timer)
    if (consumed > 0) buffer = buffer.subarray(consumed)
    if (error) current.reject(error)
    else current.resolve(response)
  }

  const terminate = (error, { destroy = true } = {}) => {
    if (terminalError) return
    terminalError = error
    finishPending(error)
    if (destroy) socket.destroy?.()
  }

  const pump = () => {
    if (!pending || terminalError) return
    if (buffer.length > maxBytes) {
      terminate(mailError('Mail server response is too large', 502, 'MAIL_RESPONSE_TOO_LARGE'))
      return
    }
    const end = pending.locateEnd(buffer)
    if (end > 0) finishPending(null, buffer.subarray(0, end), end)
  }

  const onData = (chunk) => {
    if (terminalError) return
    const incoming = Buffer.from(chunk)
    if (buffer.length + incoming.length > maxBytes) {
      terminate(mailError('Mail server response is too large', 502, 'MAIL_RESPONSE_TOO_LARGE'))
      return
    }
    buffer = Buffer.concat([buffer, incoming])
    pump()
  }
  const onError = (error) => terminate(error)
  const onClose = () => terminate(
    mailError('Mail server closed the connection', 502, 'MAIL_CONNECTION_CLOSED'),
    { destroy: false },
  )
  const onTimeout = () => terminate(mailError('Mail server response timed out', 504, 'MAIL_TIMEOUT'))

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)
  socket.on('timeout', onTimeout)

  return {
    read(locateEnd) {
      if (terminalError) return Promise.reject(terminalError)
      if (pending) return Promise.reject(mailError('Mail protocol already has a pending command', 500))
      return new Promise((resolve, reject) => {
        pending = {
          locateEnd,
          resolve,
          reject,
          timer: setTimeout(onTimeout, timeoutMs),
        }
        pump()
      })
    },
    abort(error = mailError('Mail protocol operation aborted', 504, 'MAIL_TIMEOUT')) {
      terminate(error)
    },
    isTerminated() {
      return !!terminalError
    },
    close() {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('timeout', onTimeout)
      if (!terminalError) terminalError = mailError('Mail protocol reader closed', 502)
      finishPending(terminalError)
    },
  }
}

async function runBoundedSessionOperation(
  session,
  operation,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
) {
  const parsedTimeout = Number(timeoutMs)
  const boundedTimeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? Math.trunc(parsedTimeout)
    : DEFAULT_OPERATION_TIMEOUT_MS
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = mailError('Mail operation timed out', 504, 'MAIL_OPERATION_TIMEOUT')
      if (session.reader?.abort) session.reader.abort(error)
      else session.socket?.destroy?.()
      reject(error)
    }, boundedTimeout)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function firstLineEnd(buffer) {
  const index = buffer.indexOf('\r\n')
  return index === -1 ? -1 : index + 2
}

function locateSmtpResponse(buffer) {
  let offset = 0
  let responseCode = ''
  while (offset < buffer.length) {
    const relativeEnd = buffer.subarray(offset).indexOf('\r\n')
    if (relativeEnd === -1) return -1
    const end = offset + relativeEnd
    const line = buffer.subarray(offset, end).toString('utf8')
    const match = /^(\d{3})([ -])/.exec(line)
    if (!match) return -1
    if (!responseCode) responseCode = match[1]
    offset = end + 2
    if (match[1] === responseCode && match[2] === ' ') return offset
  }
  return -1
}

function smtpStatus(response) {
  return Number(response.subarray(0, 3).toString('ascii'))
}

function assertSmtpStatus(response, accepted, label) {
  const status = smtpStatus(response)
  if (!accepted.includes(status)) {
    throw mailError(`SMTP ${label} failed (${Number.isFinite(status) ? status : 'invalid response'})`, 502, 'SMTP_COMMAND_FAILED')
  }
}

async function smtpCommand(session, command, accepted, label) {
  if (command !== null) session.socket.write(`${command}\r\n`)
  const response = await session.reader.read(locateSmtpResponse)
  assertSmtpStatus(response, accepted, label)
  return response
}

async function upgradeSocketToTls(session, host, dependencies) {
  session.reader.close()
  const tlsConnect = dependencies.tlsConnect || tls.connect
  const socket = tlsConnect({ socket: session.socket, servername: host, rejectUnauthorized: true })
  try {
    await waitForSocket(socket, 'secureConnect', session.timeoutMs)
  } catch (error) {
    socket.destroy?.()
    throw error
  }
  session.socket = socket
  session.reader = createResponseReader(socket, { timeoutMs: session.timeoutMs })
}

async function openSmtpSession(settings, dependencies = {}) {
  const socket = await openSocket({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    timeoutMs: settings.timeoutMs,
  }, dependencies)
  const session = {
    socket,
    reader: createResponseReader(socket, { timeoutMs: settings.timeoutMs }),
    timeoutMs: settings.timeoutMs,
  }
  try {
    await smtpCommand(session, null, [220], 'greeting')
    await smtpCommand(session, 'EHLO localhost', [250], 'EHLO')
    if (settings.smtpStartTls) {
      await smtpCommand(session, 'STARTTLS', [220], 'STARTTLS')
      await upgradeSocketToTls(session, settings.smtpHost, dependencies)
      await smtpCommand(session, 'EHLO localhost', [250], 'EHLO')
    }
    await smtpCommand(session, 'AUTH LOGIN', [334], 'authentication')
    await smtpCommand(session, Buffer.from(settings.user).toString('base64'), [334], 'authentication')
    await smtpCommand(session, Buffer.from(settings.password).toString('base64'), [235], 'authentication')
    return session
  } catch (error) {
    session.reader.close()
    session.socket.destroy?.()
    throw error
  }
}

async function closeSmtpSession(session) {
  if (!session.reader.isTerminated()) {
    try { await smtpCommand(session, 'QUIT', [221, 250], 'QUIT') } catch { /* best effort */ }
  }
  session.reader.close()
  session.socket.end?.()
}

export async function probeSmtp(settings, dependencies = {}) {
  const session = await openSmtpSession(settings, dependencies)
  await closeSmtpSession(session)
  return true
}

function assertHeader(value, label, maxLength = 998) {
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

function buildMimeMessage({ from, to, subject, text, html }) {
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

export async function sendSmtpMessage(settings, input = {}, dependencies = {}) {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => validateEmail(value, 'recipient'))
  if (!recipients.length || recipients.length > 20) throw mailError('between 1 and 20 recipients are required')
  const from = validateEmail(input.from || settings.from, 'sender')
  const authenticatedUser = validateEmail(settings.user, 'MAIL_USER')
  if (from.toLowerCase() !== authenticatedUser.toLowerCase()) {
    throw mailError('sender must match the authenticated QQ Mail account')
  }
  const subject = assertHeader(input.subject || '(no subject)', 'subject', 500)
  const message = buildMimeMessage({ from, to: recipients, subject, text: input.text, html: input.html })
  const dotStuffed = message.replace(/^\./gm, '..')
  const session = await openSmtpSession(settings, dependencies)
  try {
    await runBoundedSessionOperation(session, async () => {
      await smtpCommand(session, `MAIL FROM:<${from}>`, [250], 'MAIL FROM')
      for (const recipient of recipients) {
        await smtpCommand(session, `RCPT TO:<${recipient}>`, [250, 251], 'RCPT TO')
      }
      await smtpCommand(session, 'DATA', [354], 'DATA')
      await smtpCommand(session, `${dotStuffed}\r\n.`, [250], 'message delivery')
    }, settings.operationTimeoutMs)
  } finally {
    await closeSmtpSession(session)
  }
  return { sent: true, to: recipients, from, subject }
}

function imapQuote(value) {
  const text = String(value ?? '')
  if (!text || /[\0\r\n]/.test(text)) throw mailError('IMAP credential is invalid')
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function locateImapTaggedResponse(buffer, tag) {
  let offset = 0
  while (offset < buffer.length) {
    const relativeEnd = buffer.subarray(offset).indexOf('\r\n')
    if (relativeEnd === -1) return -1
    const end = offset + relativeEnd
    const line = buffer.subarray(offset, end).toString('utf8')
    offset = end + 2
    const literal = /\{(\d+)\+?\}$/.exec(line)
    if (literal) {
      const length = Number(literal[1])
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) return -1
      offset += length
      continue
    }
    if (line.startsWith(`${tag} `)) return offset
  }
  return -1
}

function taggedStatus(response, tag) {
  const text = response.toString('utf8')
  const match = new RegExp(`(?:^|\\r\\n)${tag} (OK|NO|BAD)(?: |\\r\\n)`, 'i').exec(text)
  return match?.[1]?.toUpperCase() || ''
}

async function imapCommand(session, command, label) {
  const tag = `A${String(session.nextTag).padStart(4, '0')}`
  session.nextTag += 1
  session.socket.write(`${tag} ${command}\r\n`)
  const response = await session.reader.read((buffer) => locateImapTaggedResponse(buffer, tag))
  if (taggedStatus(response, tag) !== 'OK') {
    throw mailError(`IMAP ${label} failed`, 502, 'IMAP_COMMAND_FAILED')
  }
  return response
}

async function openImapSession(settings, dependencies = {}) {
  let socket = await openSocket({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapSecure,
    timeoutMs: settings.timeoutMs,
  }, dependencies)
  let reader = createResponseReader(socket, { timeoutMs: settings.timeoutMs, maxBytes: MAX_PROTOCOL_BYTES })
  try {
    const greeting = await reader.read(firstLineEnd)
    const greetingText = greeting.toString('utf8')
    if (!/^\* (OK|PREAUTH)\b/i.test(greetingText)) throw mailError('IMAP greeting failed', 502)
    const session = { socket, reader, nextTag: 1 }
    if (!settings.imapSecure) {
      await imapCommand(session, 'STARTTLS', 'STARTTLS')
      reader.close()
      const tlsConnect = dependencies.tlsConnect || tls.connect
      socket = tlsConnect({ socket, servername: settings.imapHost, rejectUnauthorized: true })
      await waitForSocket(socket, 'secureConnect', settings.timeoutMs)
      reader = createResponseReader(socket, { timeoutMs: settings.timeoutMs, maxBytes: MAX_PROTOCOL_BYTES })
      session.socket = socket
      session.reader = reader
    }
    if (!/^\* PREAUTH\b/i.test(greetingText)) {
      await imapCommand(session, `LOGIN ${imapQuote(settings.user)} ${imapQuote(settings.password)}`, 'authentication')
    }
    return session
  } catch (error) {
    reader.close()
    socket.destroy?.()
    throw error
  }
}

async function closeImapSession(session) {
  if (!session.reader.isTerminated()) {
    try { await imapCommand(session, 'LOGOUT', 'LOGOUT') } catch { /* best effort */ }
  }
  session.reader.close()
  session.socket.end?.()
}

export async function probeImap(settings, dependencies = {}) {
  const session = await openImapSession(settings, dependencies)
  await closeImapSession(session)
  return true
}

function extractImapLiterals(response) {
  const literals = []
  let offset = 0
  while (offset < response.length) {
    const relativeEnd = response.subarray(offset).indexOf('\r\n')
    if (relativeEnd === -1) break
    const end = offset + relativeEnd
    const line = response.subarray(offset, end).toString('utf8')
    offset = end + 2
    const match = /\{(\d+)\+?\}$/.exec(line)
    if (!match) continue
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > response.length) break
    literals.push(response.subarray(offset, offset + length))
    offset += length
  }
  return literals
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

function decodeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset, encoding, encoded) => {
    try {
      if (encoding.toLowerCase() === 'b') return decodeBytes(Buffer.from(encoded, 'base64'), charset)
      return decodeQuotedPrintable(encoded.replace(/_/g, ' '), charset)
    } catch {
      return encoded
    }
  })
}

function parseHeaders(rawHeaders) {
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

function splitHeaderBody(raw) {
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

function decodeMimeEntity(raw, depth = 0) {
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

function metadataFromResponse(response, uid) {
  const raw = response.toString('utf8')
  const literal = extractImapLiterals(response)[0]?.toString('utf8') || ''
  const headers = parseHeaders(literal)
  const flags = /FLAGS \(([^)]*)\)/i.exec(raw)?.[1]?.split(/\s+/).filter(Boolean) || []
  return {
    uid: String(uid),
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    date: headers.date || /INTERNALDATE "([^"]+)"/i.exec(raw)?.[1] || '',
    messageId: headers['message-id'] || '',
    read: flags.some((flag) => flag.toLowerCase() === '\\seen'),
  }
}

function appendBoundedListMessage(messages, message, totalBytes, maxBytes = MAX_LIST_RESULT_BYTES) {
  const nextBytes = totalBytes + Buffer.byteLength(JSON.stringify(message), 'utf8')
  if (nextBytes > maxBytes) {
    throw mailError('Mail list response is too large', 502, 'MAIL_RESPONSE_TOO_LARGE')
  }
  messages.push(message)
  return nextBytes
}

function validateUid(value) {
  const uid = String(value ?? '').trim()
  if (uid.length > 20 || !/^\d+$/.test(uid) || uid === '0') throw mailError('mail UID is invalid')
  return uid
}

export async function listImapMessages(settings, { limit = 20, ...dependencies } = {}) {
  const pageSize = Math.max(1, Math.min(Number(limit) || 20, 50))
  const session = await openImapSession(settings, dependencies)
  try {
    return await runBoundedSessionOperation(session, async () => {
      await imapCommand(session, 'SELECT "INBOX"', 'SELECT')
      const search = await imapCommand(session, 'UID SEARCH ALL', 'SEARCH')
      const searchLine = /(?:^|\r\n)\* SEARCH([^\r\n]*)/i.exec(search.toString('utf8'))?.[1] || ''
      const uids = searchLine.trim().split(/\s+/).filter((uid) => /^\d+$/.test(uid)).slice(-pageSize).reverse()
      const messages = []
      let totalBytes = 0
      for (const uid of uids) {
        const response = await imapCommand(
          session,
          `UID FETCH ${uid} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`,
          'FETCH',
        )
        totalBytes = appendBoundedListMessage(messages, metadataFromResponse(response, uid), totalBytes)
      }
      return { messages }
    }, settings.operationTimeoutMs)
  } finally {
    await closeImapSession(session)
  }
}

export async function readImapMessage(settings, { uid, ...dependencies } = {}) {
  const safeUid = validateUid(uid)
  const session = await openImapSession(settings, dependencies)
  try {
    return await runBoundedSessionOperation(session, async () => {
      await imapCommand(session, 'SELECT "INBOX"', 'SELECT')
      const response = await imapCommand(
        session,
        `UID FETCH ${safeUid} (UID RFC822.SIZE FLAGS INTERNALDATE BODY.PEEK[]<0.${MAX_MESSAGE_BYTES}>)`,
        'FETCH',
      )
      const literal = extractImapLiterals(response)[0]
      if (!literal) throw mailError('Mail message was not found', 404, 'MAIL_NOT_FOUND')
      const rawMessage = literal.toString('utf8')
      const { headers } = splitHeaderBody(rawMessage)
      const decoded = decodeMimeEntity(rawMessage)
      const fullSize = Number(/RFC822\.SIZE (\d+)/i.exec(response.toString('utf8'))?.[1] || literal.length)
      return {
        uid: safeUid,
        from: headers.from || '',
        to: headers.to || '',
        subject: headers.subject || '',
        date: headers.date || '',
        messageId: headers['message-id'] || '',
        text: decoded.text,
        html: decoded.html,
        truncated: fullSize > literal.length,
        size: fullSize,
      }
    }, settings.operationTimeoutMs)
  } finally {
    await closeImapSession(session)
  }
}

export async function testQqMailCredentials({ config = {}, secret = {}, env = process.env, mailClient = {} } = {}) {
  let settings
  try {
    settings = resolveQqMailSettings({
      config,
      secret,
      env,
      allowEnvCredentials: allowQqMailEnvCredentials(env),
    })
    await (mailClient.probeSmtp || probeSmtp)(settings)
    await (mailClient.probeImap || probeImap)(settings)
    return { ok: true, message: `QQ Mail SMTP and IMAP connected for ${settings.user}` }
  } catch (error) {
    return {
      ok: false,
      message: `QQ Mail connection failed: ${safeErrorMessage(error, [
        settings?.password,
        secret.password,
        secret.authorizationCode,
        env.MAIL_PASSWORD,
      ])}`,
    }
  }
}

export async function testMailCredentials({ provider = 'custom_mail', config = {}, secret = {}, env = process.env, mailClient = {} } = {}) {
  let settings
  try {
    settings = resolveMailSettings({ provider, config, secret, env, allowEnvCredentials: false })
    await (mailClient.probeSmtp || probeSmtp)(settings)
    await (mailClient.probeImap || probeImap)(settings)
    return { ok: true, message: `${provider} SMTP and IMAP connected for ${settings.user}` }
  } catch (error) {
    return {
      ok: false,
      message: `${provider} connection failed: ${safeErrorMessage(error, [
        settings?.password,
        secret.password,
        secret.authorizationCode,
      ])}`,
    }
  }
}

export const _mailInternals = Object.freeze({
  appendBoundedListMessage,
  buildMimeMessage,
  createResponseReader,
  decodeHeader,
  decodeMimeEntity,
  extractImapLiterals,
  locateImapTaggedResponse,
  locateSmtpResponse,
  parseHeaders,
  runBoundedSessionOperation,
})
