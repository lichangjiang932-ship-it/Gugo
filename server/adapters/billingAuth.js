import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { readJson, sendJson, authToken } from '../utils.js'
import {
  resolveClientId,
  recordPasswordFailure,
  isAccountLocked,
  clearPasswordFailures,
} from '../utils/loginGuard.js'
import { logger, logWarn } from '../utils/logger.js'

import {
  getUserById,
  getUserByEmail,
  createUser,
  updateUserCredits,
  deductUserCredits,
  setUserPassword,
  clearUserPassword,
  getSessionByToken,
  createSession,
  createLoginCode,
  getLoginCode,
  incrementLoginAttempts,
  deleteLoginCode,
  deleteExpiredCodes,
  addLedgerEntry,
  getLedgerForUser,
  migrateFromJson,
  checkRateLimit,
} from '../db.js'

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'server-data')

function getDataDir() {
  return process.env.APP_DATA_DIR || DEFAULT_DATA_DIR
}

function getStorePath() {
  return path.join(getDataDir(), 'app-data.json')
}

export const RECHARGE_PACKAGES = [
  { id: 'local-10', amount: 10, credits: 1000, label: '10 元' },
  { id: 'local-50', amount: 50, credits: 5000, label: '50 元' },
  { id: 'local-100', amount: 100, credits: 11000, label: '100 元' },
  { id: 'local-300', amount: 300, credits: 36000, label: '300 元' },
]

/* ── 旧 JSON 迁移 ── */

function maybeMigrateLegacy() {
  const storePath = getStorePath()
  const migratedFlag = path.join(getDataDir(), '.migrated')
  if (!fs.existsSync(storePath) || fs.existsSync(migratedFlag)) return
  try {
    const raw = fs.readFileSync(storePath, 'utf8')
    const store = JSON.parse(raw)
    migrateFromJson(store)
    fs.writeFileSync(migratedFlag, JSON.stringify({ migratedAt: Date.now() }))
    // 保留原文件作为备份，不改名
    if (process.env.NODE_ENV !== 'production') logger.info('[billingAuth] Migrated legacy JSON store to SQLite')
  } catch (e) {
    // D4: 迁移失败属于需要排障的信号,生产也要 log(原来仅 dev warn)。
    logWarn('billingAuth.legacyMigrate', e, { storePath })
  }
}

let migrationChecked = false

function ensureLegacyMigration() {
  if (migrationChecked) return
  migrationChecked = true
  maybeMigrateLegacy()
}

/* ── 工具函数 ── */

function normalizeEmail(email = '') {
  return email.trim().toLowerCase()
}

function createCode() {
  return String(crypto.randomInt(100000, 1000000))
}

function createToken() {
  return `tkn_${crypto.randomBytes(24).toString('hex')}`
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    credits: user.credits || 0,
    hasPassword: !!user.password_hash,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  }
}

/* ── 密码 ── */

const PWD_ITERATIONS = 120000
const PWD_KEYLEN = 32
const PWD_DIGEST = 'sha256'

function hashPassword(plain, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .pbkdf2Sync(String(plain), salt, PWD_ITERATIONS, PWD_KEYLEN, PWD_DIGEST)
    .toString('hex')
  return { hash, salt }
}

function verifyPasswordHash(plain, salt, expectedHash) {
  if (!salt || !expectedHash) return false
  const { hash } = hashPassword(plain, salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function validatePasswordStrength(plain) {
  if (typeof plain !== 'string') return '密码必须为字符串'
  if (plain.length < 8) return '密码至少 8 位'
  if (plain.length > 128) return '密码最多 128 位'
  if (!/[A-Za-z]/.test(plain) || !/\d/.test(plain)) return '密码需同时含字母和数字'
  return null
}

export function setPasswordForUser({ token, currentPassword, newPassword, now = Date.now() }) {
  ensureLegacyMigration()
  const user = getUserByToken(token)
  if (!user) throw new Error('未登录或会话已过期')
  const err = validatePasswordStrength(newPassword)
  if (err) throw new Error(err)
  if (user.password_hash) {
    if (!currentPassword) throw new Error('请提供当前密码')
    if (!verifyPasswordHash(currentPassword, user.password_salt, user.password_hash)) {
      throw new Error('当前密码不正确')
    }
  }
  const { hash, salt } = hashPassword(newPassword)
  const updated = setUserPassword({ id: user.id, passwordHash: hash, passwordSalt: salt, now })
  return { ok: true, user: publicUser(updated) }
}

export function removePasswordForUser({ token, currentPassword, now = Date.now() }) {
  ensureLegacyMigration()
  const user = getUserByToken(token)
  if (!user) throw new Error('未登录或会话已过期')
  if (!user.password_hash) throw new Error('当前未设置密码')
  if (!verifyPasswordHash(currentPassword, user.password_salt, user.password_hash)) {
    throw new Error('当前密码不正确')
  }
  const updated = clearUserPassword({ id: user.id, now })
  return { ok: true, user: publicUser(updated) }
}

export function loginWithPassword({ email, password, now = Date.now() }) {
  ensureLegacyMigration()
  if (!email || !password) throw new Error('邮箱与密码不能为空')
  const normalized = String(email).trim().toLowerCase()
  // ★ C-P2.5: 账号维度锁定(与发码限流分离),多次失败先拒。
  if (isAccountLocked(normalized)) {
    throw new Error('账号因多次登录失败已被临时锁定，请 15 分钟后再试')
  }
  const user = getUserByEmail(normalized)
  // 统一报错避免透露「账号是否存在」
  const FAIL = new Error('邮箱或密码不正确')
  if (!user || !user.password_hash) {
    recordPasswordFailure(normalized)
    throw FAIL
  }
  if (!verifyPasswordHash(password, user.password_salt, user.password_hash)) {
    recordPasswordFailure(normalized)
    throw FAIL
  }
  // 成功:清空失败计数
  clearPasswordFailures(normalized)
  const token = createToken()
  createSession({ token, userId: user.id, now, ttlMs: 7 * 24 * 60 * 60 * 1000 })
  return { ok: true, token, user: publicUser(user), ledger: getLedgerForUser(user.id) }
}

function getUserByToken(token) {
  const session = getSessionByToken(token)
  if (!session) return null
  return getUserById(session.user_id) || null
}

/* ── 验证码发送限制 ── */

const MAX_CODES_PER_HOUR = 5
const CODE_WINDOW_MS = 60 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 5
const CODE_TTL_MS = 10 * 60 * 1000

function hashLoginCode(code) {
  return `sha256:${crypto.createHash('sha256').update(String(code)).digest('hex')}`
}

function loginCodesMatch(storedCode, candidateCode) {
  const expected = String(storedCode || '').startsWith('sha256:')
    ? String(storedCode)
    : hashLoginCode(storedCode)
  const actual = hashLoginCode(candidateCode)
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function checkCodeRate(clientId) {
  const key = `code:${clientId}`
  return checkRateLimit({ key, windowMs: CODE_WINDOW_MS, maxRequests: MAX_CODES_PER_HOUR })
}

// ★ C-P2.5: 密码登录限流用独立 key,与发码窗口分离(避免改密码误伤发码,反之亦然)。
const MAX_PASSWORD_ATTEMPTS_PER_WINDOW = 10
function checkPasswordLoginRate(clientId) {
  const key = `pwd_login:${clientId}`
  return checkRateLimit({ key, windowMs: CODE_WINDOW_MS, maxRequests: MAX_PASSWORD_ATTEMPTS_PER_WINDOW })
}

/* ── 核心逻辑 ── */

export function issueEmailCode({ email, now = Date.now(), code }) {
  ensureLegacyMigration()
  const normalized = normalizeEmail(email)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error('请输入有效邮箱地址')
  }
  const actualCode = code || createCode()
  createLoginCode({ email: normalized, code: hashLoginCode(actualCode), now, ttlMs: CODE_TTL_MS })
  deleteExpiredCodes(now)
  return { ok: true, email: normalized, expiresIn: CODE_TTL_MS / 1000, devCode: actualCode }
}

export function verifyEmailCode({ email, code, now = Date.now() }) {
  ensureLegacyMigration()
  const normalized = normalizeEmail(email)
  const record = getLoginCode(normalized)
  if (!record) throw new Error('验证码不存在或已过期')

  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    deleteLoginCode(normalized)
    throw new Error('验证失败次数过多，请重新获取验证码')
  }

  if (!loginCodesMatch(record.code, String(code).trim())) {
    incrementLoginAttempts(normalized)
    throw new Error('验证码不正确')
  }

  if (record.expires_at < now) {
    deleteLoginCode(normalized)
    throw new Error('验证码已过期')
  }

  const userId = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24)
  let user = getUserById(userId)
  if (!user) {
    user = createUser({ id: userId, email: normalized, credits: 0, now })
  }
  deleteLoginCode(normalized)

  const token = createToken()
  createSession({ token, userId, now, ttlMs: 7 * 24 * 60 * 60 * 1000 }) // 7 天

  return { ok: true, token, user: publicUser(user), ledger: getLedgerForUser(userId) }
}

export function getPublicAccount({ token }) {
  ensureLegacyMigration()
  const user = getUserByToken(token)
  if (!user) throw new Error('请先登录')
  return publicUser(user)
}

export function rechargeAccount({ token, packageId, now = Date.now() }) {
  ensureLegacyMigration()
  const user = getUserByToken(token)
  if (!user) throw new Error('请先登录')
  const pack = RECHARGE_PACKAGES.find((item) => item.id === packageId)
  if (!pack) throw new Error('充值套餐不存在')

  const newCredits = (user.credits || 0) + pack.credits
  updateUserCredits({ id: user.id, credits: newCredits, now })

  addLedgerEntry({
    id: crypto.randomUUID?.() || `led_${now}_${Math.random().toString(16).slice(2)}`,
    userId: user.id,
    type: 'recharge',
    packageId,
    amount: pack.amount,
    credits: pack.credits,
    balance: newCredits,
    now,
  })

  return { ok: true, user: publicUser(getUserById(user.id)), ledger: getLedgerForUser(user.id) }
}

/**
 * D3: 统一扣费。chargeForModelUse / chargeForToolUse 原本逐行重复,
 * 只有 ledger 的 type 和 model_name 字段不同。这里抽出公共逻辑,行为零变化。
 *
 * @param {object} p
 * @param {string} p.token   会话 token
 * @param {string} p.type    ledger 入账类型('model_charge' | 'tool_charge')
 * @param {string} p.name    入账 model_name 字段(模型名或工具名)
 * @param {number} p.cost    扣减积分
 */
function chargeCredits({ token, type, name, cost, now = Date.now() }) {
  ensureLegacyMigration()
  const user = getUserByToken(token)
  if (!user) throw new Error('请先登录')
  // ★ 免费请求(本地模型)直接返回,不写账本 —— 否则每轮都留一条
  // credits: -0 的空记录,把真实消费记录淹掉。返回形状与正常路径一致。
  if (!(cost > 0)) {
    return { ok: true, user: publicUser(user), ledger: getLedgerForUser(user.id) }
  }
  if ((user.credits || 0) < cost) {
    throw new Error(`积分不足，需要 ${cost} 积分，当前余额 ${user.credits || 0}`)
  }

  const result = deductUserCredits({ id: user.id, amount: cost, now })
  if (!result.changed) {
    throw new Error(`积分不足，需要 ${cost} 积分`)
  }

  addLedgerEntry({
    id: crypto.randomUUID?.() || `led_${now}_${Math.random().toString(16).slice(2)}`,
    userId: user.id,
    type,
    modelName: name,
    credits: -cost,
    balance: result.user.credits,
    now,
  })

  return { ok: true, user: publicUser(result.user), ledger: getLedgerForUser(user.id) }
}

export function chargeForModelUse({ token, modelName, cost, now = Date.now() }) {
  return chargeCredits({ token, type: 'model_charge', name: modelName, cost, now })
}

/* ── 计费配置 ── */

// ★ batchF P1: 工具调用(搜索/抓取)也走鉴权和计费,
//   防止未登录用户直接打 /api/tools/* 白嫖后端资源.
//   固定费率,从 env CREDIT_TOOL_COST 读,默认 1 积分/次.
export function getToolCost(env = process.env) {
  const raw = Number(env.CREDIT_TOOL_COST)
  if (!Number.isFinite(raw) || raw < 0) return 1
  return raw
}

export function chargeForToolUse({ token, toolName, cost, now = Date.now() }) {
  return chargeCredits({ token, type: 'tool_charge', name: toolName, cost, now })
}

export function loadBillingConfig(env = process.env) {
  const basePer1k = Number(env.CREDIT_BASE_PER_1K_TOKENS ?? 10)
  // ★ MODEL_MAX_TOKENS 现在默认「不限制」(0 / 未设置),但**计费预估仍然需要
  // 一个有限数字**来预扣积分 —— 不能因为不限制输出就不预留额度。
  // 用户显式配了上限就按它算,没配就用一个保守的估算值。
  // 这个值只影响「预扣多少」,实际扣费在流结束后按真实 usage 结算。
  const configured = Number(env.MODEL_MAX_TOKENS)
  const estimateTokens = Number(env.CREDIT_ESTIMATE_OUTPUT_TOKENS ?? 4096)
  const maxTokens = Number.isFinite(configured) && configured > 0
    ? configured
    : (Number.isFinite(estimateTokens) && estimateTokens > 0 ? estimateTokens : 4096)
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

/* ── Token 估算 ── */

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

function estimateImageTokensFromUrl(url = '') {
  const text = String(url || '')
  if (!text.startsWith('data:image/')) return 1000
  const comma = text.indexOf(',')
  const payload = comma >= 0 ? text.slice(comma + 1) : text
  const approxBytes = Math.floor((payload.length * 3) / 4)
  return Math.max(85, Math.ceil(approxBytes / 750))
}

function imageTokenCount(messages) {
  let total = 0
  for (const message of messages || []) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type === 'image_url') {
        total += estimateImageTokensFromUrl(part.image_url?.url || '')
      }
    }
  }
  return total
}

function roughTokenCount(messages) {
  const text = messages.map((m) => contentToText(m.content)).join('\n')
  return Math.max(1, Math.ceil(text.length / 4) + imageTokenCount(messages))
}

export function estimateChatCost({ modelName, messages, config }) {
  const inputTokens = roughTokenCount(messages)
  const budgetTokens = inputTokens + config.maxTokens
  const multiplier = config.multipliers[modelName] || 1
  const baseCost = Math.max(1, Math.ceil((budgetTokens / 1000) * config.basePer1k))
  return Math.ceil(baseCost * multiplier)
}

/**
 * 流结束后按上游真实 usage 结算。预估值只用于请求前余额校验，不能直接当账单。
 * reasoning token 按 OpenAI 兼容协议计入 completion_tokens，因此自然包含在内。
 */
export function calculateChatCostFromUsage({ modelName, usage, config }) {
  const promptTokens = Math.max(0, Number(usage?.promptTokens) || 0)
  const completionTokens = Math.max(0, Number(usage?.completionTokens) || 0)
  const totalTokens = promptTokens + completionTokens
  if (!(totalTokens > 0)) return 0
  const multiplier = config.multipliers[modelName] || 1
  const baseCost = Math.max(1, Math.ceil((totalTokens / 1000) * config.basePer1k))
  return Math.ceil(baseCost * multiplier)
}

export function calculateModelCostUsd({ modelName, usage, env = process.env }) {
  let rates
  try {
    rates = JSON.parse(String(env.MODEL_USD_RATES || '{}'))
  } catch {
    return 0
  }
  const rate = rates?.[modelName]
  if (!rate || typeof rate !== 'object') return 0
  const inputRate = Math.max(0, Number(rate.input) || 0)
  const outputRate = Math.max(0, Number(rate.output) || 0)
  const promptTokens = Math.max(0, Number(usage?.promptTokens) || 0)
  const completionTokens = Math.max(0, Number(usage?.completionTokens) || 0)
  return (promptTokens * inputRate + completionTokens * outputRate) / 1_000_000
}

/* ── SMTP 邮件发送 ── */

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

export async function sendEmailCode({ env, email, code }) {
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

/* ── HTTP 处理 ── */

function clientId(req, env = process.env) {
  // ★ C-P2.5: 默认不信可伪造的 x-forwarded-for;仅 TRUST_PROXY=1 时采信 XFF 最左 hop。
  return resolveClientId(req, env)
}

export async function handleAuthBillingRequest(req, res, env = process.env) {
  ensureLegacyMigration()
  try {
    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'POST' && url.pathname === '/api/auth/send-code') {
      const body = await readJson(req, { maxBytes: 256 * 1024 })
      const limit = checkCodeRate(clientId(req, env))
      if (!limit.allowed) {
        sendJson(res, 429, { ok: false, error: '发送验证码次数过多，请 1 小时后再试' })
        return
      }
      const issued = issueEmailCode({ email: body.email })
      const delivery = await sendEmailCode({ env, email: issued.email, code: issued.devCode })
      sendJson(res, 200, buildSendCodeResponse({ issued, delivery, env }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
      const body = await readJson(req, { maxBytes: 256 * 1024 })
      const result = verifyEmailCode({ email: body.email, code: body.code })
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login-password') {
      const body = await readJson(req, { maxBytes: 256 * 1024 })
      const limit = checkPasswordLoginRate(clientId(req, env))
      if (!limit.allowed) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return
      }
      const result = loginWithPassword({ email: body.email, password: body.password })
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/account/password') {
      const body = await readJson(req, { maxBytes: 256 * 1024 })
      const result = setPasswordForUser({
        token: authToken(req),
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      })
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/api/account/password') {
      const body = await readJson(req, { maxBytes: 256 * 1024 })
      const result = removePasswordForUser({
        token: authToken(req),
        currentPassword: body.currentPassword,
      })
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/account/me') {
      const token = authToken(req)
      const user = getPublicAccount({ token })
      sendJson(res, 200, { ok: true, user, ledger: getLedgerForUser(user.id), packages: RECHARGE_PACKAGES })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/billing/packages') {
      sendJson(res, 200, { ok: true, packages: RECHARGE_PACKAGES })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/billing/recharge') {
      const body = await readJson(req, { maxBytes: 256 * 1024 })
      const result = rechargeAccount({ token: authToken(req), packageId: body.packageId })
      sendJson(res, 200, { ...result, packages: RECHARGE_PACKAGES })
      return
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' })
  } catch (error) {
    // ★ #36: 尊重 readJson 抛的 statusCode (e.g. 413)
    const status = error?.statusCode || 400
    sendJson(res, status, { ok: false, error: error.message || '请求失败' })
  }
}
