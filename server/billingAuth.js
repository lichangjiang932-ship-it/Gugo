import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const DATA_DIR = path.join(process.cwd(), 'server-data')
const STORE_PATH = path.join(DATA_DIR, 'app-data.json')
const CODE_TTL_MS = 10 * 60 * 1000

export const RECHARGE_PACKAGES = [
  { id: 'local-10', amount: 10, credits: 1000, label: '10 元' },
  { id: 'local-50', amount: 50, credits: 5000, label: '50 元' },
  { id: 'local-100', amount: 100, credits: 11000, label: '100 元' },
  { id: 'local-300', amount: 300, credits: 36000, label: '300 元' },
]

export function createMemoryStore(seed = {}) {
  return {
    users: {},
    codes: {},
    sessions: {},
    ledger: [],
    ...seed,
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

export function loadStore() {
  ensureDataDir()
  if (!fs.existsSync(STORE_PATH)) return createMemoryStore()
  try {
    return { ...createMemoryStore(), ...JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) }
  } catch {
    return createMemoryStore()
  }
}

export function saveStore(store) {
  ensureDataDir()
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

function normalizeEmail(email = '') {
  return email.trim().toLowerCase()
}

function createCode() {
  return String(crypto.randomInt(100000, 1000000))
}

function createToken() {
  return `usr_${crypto.randomBytes(24).toString('hex')}`
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    credits: user.credits || 0,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function getUserByToken(store, token) {
  const userId = store.sessions[token]
  if (!userId) return null
  return store.users[userId] || null
}

export function issueEmailCode({ store, email, now = Date.now(), code = createCode() }) {
  const normalized = normalizeEmail(email)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error('请输入有效邮箱地址')
  }
  store.codes[normalized] = {
    code,
    expiresAt: now + CODE_TTL_MS,
    createdAt: now,
  }
  return { ok: true, email: normalized, expiresIn: CODE_TTL_MS / 1000, devCode: code }
}

export function verifyEmailCode({ store, email, code, now = Date.now() }) {
  const normalized = normalizeEmail(email)
  const record = store.codes[normalized]
  if (!record || record.code !== String(code).trim()) throw new Error('验证码不正确')
  if (record.expiresAt < now) throw new Error('验证码已过期')

  const userId = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24)
  const existing = store.users[userId]
  const user = existing || {
    id: userId,
    email: normalized,
    credits: 0,
    createdAt: now,
  }
  user.updatedAt = now
  store.users[userId] = user
  delete store.codes[normalized]

  const token = createToken()
  store.sessions[token] = userId
  return { ok: true, token, user: publicUser(user), ledger: getLedgerForUser(store, userId) }
}

export function getPublicAccount({ store, token }) {
  const user = getUserByToken(store, token)
  if (!user) throw new Error('请先登录')
  return publicUser(user)
}

function getLedgerForUser(store, userId) {
  return store.ledger.filter((item) => item.userId === userId).slice(-50).reverse()
}

export function rechargeAccount({ store, token, packageId, now = Date.now() }) {
  const user = getUserByToken(store, token)
  if (!user) throw new Error('请先登录')
  const pack = RECHARGE_PACKAGES.find((item) => item.id === packageId)
  if (!pack) throw new Error('充值套餐不存在')

  user.credits = (user.credits || 0) + pack.credits
  user.updatedAt = now
  store.ledger.push({
    id: crypto.randomUUID?.() || `led_${now}_${Math.random().toString(16).slice(2)}`,
    userId: user.id,
    type: 'recharge',
    packageId,
    amount: pack.amount,
    credits: pack.credits,
    balance: user.credits,
    createdAt: now,
  })
  return { ok: true, user: publicUser(user), ledger: getLedgerForUser(store, user.id) }
}

export function loadBillingConfig(env = process.env) {
  const basePer1k = Number(env.CREDIT_BASE_PER_1K_TOKENS ?? 10)
  const maxTokens = Number(env.MODEL_MAX_TOKENS ?? 4096)
  const defaultModel = env.MODEL_NAME?.trim() || ''
  const multipliers = {}

  const raw = env.MODEL_PRICE_MULTIPLIERS || (defaultModel ? `${defaultModel}:1` : '')
  for (const part of raw.split(',')) {
    const [name, value] = part.split(':').map((s) => s?.trim())
    if (!name) continue
    const multiplier = Number(value || 1)
    multipliers[name] = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  }
  if (defaultModel && !multipliers[defaultModel]) multipliers[defaultModel] = 1

  return {
    basePer1k: Number.isFinite(basePer1k) && basePer1k > 0 ? basePer1k : 10,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
    multipliers,
    defaultModel,
  }
}

export function getBillingDiagnostics(env = process.env) {
  const config = loadBillingConfig(env)
  return {
    ok: true,
    basePer1k: config.basePer1k,
    maxTokens: config.maxTokens,
    defaultModel: config.defaultModel,
    multipliers: config.multipliers,
    packages: RECHARGE_PACKAGES,
  }
}

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

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text || ''
        if (part?.type === 'image_url') return '[image]'
        return JSON.stringify(part || '')
      })
      .join('\n')
  }
  return content ? JSON.stringify(content) : ''
}

function roughTokenCount(messages) {
  const text = messages.map((m) => contentToText(m.content)).join('\n')
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateChatCost({ modelName, messages, config }) {
  const inputTokens = roughTokenCount(messages)
  const budgetTokens = inputTokens + config.maxTokens
  const multiplier = config.multipliers[modelName] || 1
  const baseCost = Math.max(1, Math.ceil((budgetTokens / 1000) * config.basePer1k))
  return Math.ceil(baseCost * multiplier)
}

export function chargeForModelUse({ store, token, modelName, cost, now = Date.now() }) {
  const user = getUserByToken(store, token)
  if (!user) throw new Error('请先登录')
  if ((user.credits || 0) < cost) throw new Error(`积分不足，需要 ${cost} 积分，当前余额 ${user.credits || 0}`)

  user.credits -= cost
  user.updatedAt = now
  store.ledger.push({
    id: crypto.randomUUID?.() || `led_${now}_${Math.random().toString(16).slice(2)}`,
    userId: user.id,
    type: 'model_charge',
    modelName,
    credits: -cost,
    balance: user.credits,
    createdAt: now,
  })
  return { ok: true, user: publicUser(user), ledger: getLedgerForUser(store, user.id) }
}

function authToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() ? JSON.parse(raw) : {}
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(JSON.stringify(body))
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
    const onSecure = () => {
      cleanup()
      resolve()
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
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
    const onConnect = () => {
      cleanup()
      resolve()
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
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

/*
function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('\n')) {
        cleanup()
        resolve(buffer)
      }
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}
*/

export async function sendEmailCode({ env, email, code }) {
  if (!env.MAIL_SERVER || !env.MAIL_USERNAME || !env.MAIL_PASSWORD) {
    console.log(`[auth] ${email} login code: ${code}`)
    return { sent: false, devCode: code }
  }

  const port = Number(env.MAIL_PORT || 587)
  const useSsl = String(env.MAIL_USE_SSL).toLowerCase() === 'true'
  const sender = env.MAIL_DEFAULT_SENDER || env.MAIL_USERNAME
  const subject = 'Your Model Atelier 登录验证码'
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

  let socket = useSsl
    ? tls.connect({ host: env.MAIL_SERVER, port, servername: env.MAIL_SERVER })
    : net.connect({ host: env.MAIL_SERVER, port })
  if (useSsl) await waitForSecureConnect(socket)
  else await waitForConnect(socket)

  let readResponse = createSmtpReader(socket)
  await smtpCommand(readResponse, socket, null)
  await smtpCommand(readResponse, socket, `EHLO localhost`)
  if (!useSsl && String(env.MAIL_USE_TLS).toLowerCase() === 'true') {
    await smtpCommand(readResponse, socket, 'STARTTLS')
    socket = tls.connect({ socket, servername: env.MAIL_SERVER })
    await waitForSecureConnect(socket)
    readResponse = createSmtpReader(socket)
    await smtpCommand(readResponse, socket, `EHLO localhost`)
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

export async function handleAuthBillingRequest(req, res, env = process.env) {
  try {
    const store = loadStore()
    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'POST' && url.pathname === '/api/auth/send-code') {
      const body = await readJson(req)
      const issued = issueEmailCode({ store, email: body.email })
      const delivery = await sendEmailCode({ env, email: issued.email, code: issued.devCode })
      saveStore(store)
      sendJson(res, 200, buildSendCodeResponse({ issued, delivery, env }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
      const body = await readJson(req)
      const result = verifyEmailCode({ store, email: body.email, code: body.code })
      saveStore(store)
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/account/me') {
      const token = authToken(req)
      const user = getPublicAccount({ store, token })
      sendJson(res, 200, { ok: true, user, ledger: getLedgerForUser(store, user.id), packages: RECHARGE_PACKAGES })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/billing/packages') {
      sendJson(res, 200, { ok: true, packages: RECHARGE_PACKAGES })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/billing/recharge') {
      const body = await readJson(req)
      const result = rechargeAccount({ store, token: authToken(req), packageId: body.packageId })
      saveStore(store)
      sendJson(res, 200, { ...result, packages: RECHARGE_PACKAGES })
      return
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message || '请求失败' })
  }
}
