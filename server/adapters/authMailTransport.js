import net from 'node:net'
import tls from 'node:tls'

import { pinnedLookup, resolvePublicHost } from '../utils/outboundNetworkGuard.js'

export function getMailDiagnostics(env = process.env) {
  const required = ['MAIL_SERVER', 'MAIL_USERNAME', 'MAIL_PASSWORD', 'MAIL_DEFAULT_SENDER']
  const missing = required.filter((key) => !env[key]?.trim())
  const port = Number(env.MAIL_PORT || 587)
  return {
    ok: true,
    configured: missing.length === 0,
    missing,
    server: env.MAIL_SERVER || '',
    port: Number.isFinite(port) ? port : 587,
    useTls: String(env.MAIL_USE_TLS).toLowerCase() === 'true',
    useSsl: String(env.MAIL_USE_SSL).toLowerCase() === 'true',
    username: env.MAIL_USERNAME || '',
    sender: env.MAIL_DEFAULT_SENDER || env.MAIL_USERNAME || '',
    devCodes: String(env.AUTH_DEV_CODES).toLowerCase() === 'true',
  }
}

function createSmtpReader(socket) {
  let buffer = ''
  return function readResponse() {
    return new Promise((resolve, reject) => {
      const tryResolve = () => {
        const lines = buffer.split(/\r?\n/)
        const completeLines = lines.slice(0, -1)
        for (let i = 0; i < completeLines.length; i += 1) {
          const line = completeLines[i]
          if (/^\d{3} /.test(line)) {
            const responseLines = completeLines.slice(0, i + 1)
            buffer = [...completeLines.slice(i + 1), lines.at(-1) || ''].join('\n')
            resolve(responseLines.join('\n'))
            return true
          }
        }
        return false
      }

      if (tryResolve()) return

      const onData = (chunk) => {
        buffer += chunk.toString('utf8')
        tryResolve() && cleanup()
      }
      const onError = (err) => {
        cleanup()
        reject(err)
      }
      const onClose = () => {
        cleanup()
        reject(new Error('SMTP 连接已关闭'))
      }
      const cleanup = () => {
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
    })
  }
}

function waitForSecureConnect(socket) {
  if (socket.authorized || socket.encrypted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onSecure = () => { cleanup(); resolve() }
    const onError = (err) => { cleanup(); reject(err) }
    const cleanup = () => {
      socket.off('secureConnect', onSecure)
      socket.off('error', onError)
    }
    socket.on('secureConnect', onSecure)
    socket.on('error', onError)
  })
}

function waitForConnect(socket) {
  if (!socket.connecting) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onConnect = () => { cleanup(); resolve() }
    const onError = (err) => { cleanup(); reject(err) }
    const cleanup = () => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }
    socket.on('connect', onConnect)
    socket.on('error', onError)
  })
}

async function smtpCommand(readResponse, socket, command, expected = /^2|^3/) {
  if (command) socket.write(`${command}\r\n`)
  const response = await readResponse()
  if (!expected.test(response)) throw new Error(`SMTP 错误：${response.trim()}`)
  return response
}

export async function sendEmailCode({ env, email, code }, dependencies = {}) {
  if (String(env.AUTH_DEV_CODES).toLowerCase() === 'true') {
    return { sent: false, devCode: code }
  }
  if (!env.MAIL_SERVER || !env.MAIL_USERNAME || !env.MAIL_PASSWORD) {
    return { sent: false, devCode: code }
  }

  const port = Number(env.MAIL_PORT || 587)
  const useSsl = String(env.MAIL_USE_SSL).toLowerCase() === 'true'
  const sender = env.MAIL_DEFAULT_SENDER || env.MAIL_USERNAME
  const subject = 'Gugo 登录验证码'
  const body = `你的登录验证码是：${code}\n\n验证码 10 分钟内有效。`
  const message = [
    `From: ${sender}`,
    `To: ${email}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n')

  const { lockedIp } = await resolvePublicHost(env.MAIL_SERVER, {
    allowLocal: true,
    env,
    ...(typeof dependencies.lookupHost === 'function'
      ? { lookup: dependencies.lookupHost }
      : {}),
  })
  const connectOptions = {
    host: env.MAIL_SERVER,
    port,
    lookup: pinnedLookup(lockedIp),
  }
  const tlsConnect = dependencies.tlsConnect || tls.connect
  const netConnect = dependencies.netConnect || net.connect
  let socket = useSsl
    ? tlsConnect({ ...connectOptions, servername: env.MAIL_SERVER })
    : netConnect(connectOptions)
  if (useSsl) await waitForSecureConnect(socket)
  else await waitForConnect(socket)

  let readResponse = createSmtpReader(socket)
  await smtpCommand(readResponse, socket, null)
  await smtpCommand(readResponse, socket, 'EHLO localhost')
  if (!useSsl && String(env.MAIL_USE_TLS).toLowerCase() === 'true') {
    await smtpCommand(readResponse, socket, 'STARTTLS')
    socket = tlsConnect({ socket, servername: env.MAIL_SERVER })
    await waitForSecureConnect(socket)
    readResponse = createSmtpReader(socket)
    await smtpCommand(readResponse, socket, 'EHLO localhost')
  }
  await smtpCommand(readResponse, socket, 'AUTH LOGIN', /^3/)
  await smtpCommand(readResponse, socket, Buffer.from(env.MAIL_USERNAME).toString('base64'), /^3/)
  await smtpCommand(readResponse, socket, Buffer.from(env.MAIL_PASSWORD).toString('base64'))
  await smtpCommand(readResponse, socket, `MAIL FROM:<${sender}>`)
  await smtpCommand(readResponse, socket, `RCPT TO:<${email}>`)
  await smtpCommand(readResponse, socket, 'DATA', /^3/)
  await smtpCommand(readResponse, socket, `${message}\r\n.`)
  await smtpCommand(readResponse, socket, 'QUIT', /^2/)
  socket.end()
  return { sent: true }
}

export function buildSendCodeResponse({ issued, delivery, env }) {
  const response = { ok: true, email: issued.email, expiresIn: issued.expiresIn }
  const exposeDevCode =
    delivery?.sent === false ||
    String(env.AUTH_DEV_CODES).toLowerCase() === 'true'
  if (exposeDevCode) response.devCode = issued.devCode
  return response
}
