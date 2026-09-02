import net from 'node:net'
import tls from 'node:tls'
import { pinnedLookup, resolvePublicHost } from '../utils/outboundNetworkGuard.js'
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  MAX_LIST_RESULT_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PROTOCOL_BYTES,
  allowQqMailEnvCredentials,
  assertHeader,
  buildMimeMessage,
  decodeHeader,
  decodeMimeEntity,
  mailError,
  parseHeaders,
  resolveMailSettings,
  resolveQqMailSettings,
  safeErrorMessage,
  splitHeaderBody,
  validateEmail,
} from './mailProtocolSupport.js'

export { allowQqMailEnvCredentials, resolveMailSettings, resolveQqMailSettings }

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
