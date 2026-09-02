import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJson, sendJson, authToken } from '../utils.js'
import {
  resolveClientId,
  recordPasswordFailure,
  isAccountLocked,
  clearPasswordFailures,
} from '../utils/loginGuard.js'
import { logger, logWarn } from '../utils/logger.js'
import { buildSendCodeResponse, sendEmailCode } from './authMailTransport.js'

export { buildSendCodeResponse, getMailDiagnostics, sendEmailCode } from './authMailTransport.js'

import {
  getDb,
  getUserById,
  getUserByEmail,
  createUser,
  setUserPassword,
  clearUserPassword,
  getSessionByToken,
  createSession,
  deleteSession,
  createLoginCode,
  getLoginCode,
  incrementLoginAttempts,
  deleteLoginCode,
  deleteExpiredCodes,
  checkRateLimit,
} from '../db.js'
import { disconnectUser as disconnectMcpUser } from '../mcp/mcpManager.js'

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'server-data')

function getDataDir() {
  return process.env.APP_DATA_DIR || DEFAULT_DATA_DIR
}

function getStorePath() {
  return path.join(getDataDir(), 'app-data.json')
}

/* ── 旧 JSON 迁移 ── */

function migrateAccountsFromJson(store) {
  const now = Date.now()
  getDb().transaction(() => {
    for (const user of Object.values(store.users || {})) {
      createUser({ id: user.id, email: user.email, now: user.createdAt || now })
    }
    for (const [token, userId] of Object.entries(store.sessions || {})) {
      createSession({ token, userId, now })
    }
  })()
}

function writeMigrationFlagAtomic(migratedFlag) {
  const tempPath = `${migratedFlag}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify({ migratedAt: Date.now() }), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  try {
    fs.renameSync(tempPath, migratedFlag)
  } catch (error) {
    if (!fs.existsSync(migratedFlag)) throw error
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

function retireLegacyStore(storePath) {
  fs.unlinkSync(storePath)
}

function maybeMigrateLegacy() {
  const storePath = getStorePath()
  const migratedFlag = path.join(getDataDir(), '.migrated')
  if (!fs.existsSync(storePath)) return
  try {
    if (fs.existsSync(migratedFlag)) {
      retireLegacyStore(storePath)
      return
    }
    const raw = fs.readFileSync(storePath, 'utf8')
    const store = JSON.parse(raw)
    migrateAccountsFromJson(store)
    writeMigrationFlagAtomic(migratedFlag)
    retireLegacyStore(storePath)
    if (process.env.NODE_ENV !== 'production') logger.info('[authAccount] Migrated legacy accounts to SQLite')
  } catch (e) {
    // D4: 迁移失败属于需要排障的信号,生产也要 log(原来仅 dev warn)。
    logWarn('authAccount.legacyMigrate', e, { storePath })
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
    hasPassword: !!user.password_hash,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  }
}

const LOCAL_OWNER_META_KEY = 'local_auth_owner_user_id'
const LOCAL_USER_ID = 'local-default'
const LOCAL_USER_EMAIL = 'local@gugo.invalid'
const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function resolveAuthMode(env = process.env) {
  const raw = String(env.AUTH_MODE || 'local').trim().toLowerCase()
  if (!raw || raw === 'local') return 'local'
  if (['multi_user', 'multi-user', 'multiuser'].includes(raw)) return 'multi_user'
  throw new Error('AUTH_MODE must be local or multi_user')
}

export function isLocalOwnerUser(userId, env = process.env) {
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedUserId || resolveAuthMode(env) !== 'local') return false
  const configuredId = String(env.LOCAL_USER_ID || '').trim()
  if (configuredId) return configuredId === normalizedUserId
  const storedOwnerId = getDb().prepare(
    'SELECT value FROM meta WHERE key = ?',
  ).get(LOCAL_OWNER_META_KEY)?.value
  return String(storedOwnerId || '').trim() === normalizedUserId
}

function rememberLocalOwner(userId) {
  getDb().prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(LOCAL_OWNER_META_KEY, userId)
}

function resolveLocalOwner({ token, env, now }) {
  const configuredId = String(env.LOCAL_USER_ID || '').trim()
  if (configuredId) {
    const configured = getUserById(configuredId)
    if (!configured) throw new Error(`LOCAL_USER_ID does not exist: ${configuredId}`)
    rememberLocalOwner(configured.id)
    return configured
  }

  const storedOwnerId = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(LOCAL_OWNER_META_KEY)?.value
  const storedOwner = storedOwnerId ? getUserById(storedOwnerId) : null
  if (storedOwner) return storedOwner

  // Only an unclaimed installation may adopt an existing authenticated user.
  // Once the owner is stored, tokens from other legacy accounts cannot flip it.
  const tokenUser = token ? getUserByToken(token) : null
  if (tokenUser) {
    rememberLocalOwner(tokenUser.id)
    return tokenUser
  }

  const users = getDb().prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC').all()
  const owner = users.length === 1
    ? users[0]
    : (getUserById(LOCAL_USER_ID) || getUserByEmail(LOCAL_USER_EMAIL) || createUser({
        id: LOCAL_USER_ID,
        email: LOCAL_USER_EMAIL,
        now,
      }))
  rememberLocalOwner(owner.id)
  return owner
}

export function bootstrapAuth({ token = '', env = process.env, now = Date.now() } = {}) {
  ensureLegacyMigration()
  const mode = resolveAuthMode(env)
  if (mode === 'multi_user') {
    const user = token ? getUserByToken(token) : null
    return user
      ? { ok: true, mode, authenticated: true, user: publicUser(user) }
      : { ok: true, mode, authenticated: false }
  }

  const user = resolveLocalOwner({ token, env, now })
  const suppliedSession = token ? getSessionByToken(token) : null
  const reusableToken = suppliedSession?.user_id === user.id
    ? token
    : getDb().prepare(`
        SELECT token FROM sessions
        WHERE user_id = ? AND id IS NULL AND title IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).get(user.id, now)?.token
  const sessionToken = reusableToken || createToken()
  createSession({ token: sessionToken, userId: user.id, now, ttlMs: LOCAL_SESSION_TTL_MS })
  return { ok: true, mode, authenticated: true, token: sessionToken, user: publicUser(user) }
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
  return { ok: true, token, user: publicUser(user) }
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
    user = createUser({ id: userId, email: normalized, now })
  }
  deleteLoginCode(normalized)

  const token = createToken()
  createSession({ token, userId, now, ttlMs: 7 * 24 * 60 * 60 * 1000 }) // 7 天

  return { ok: true, token, user: publicUser(user) }
}

export function getPublicAccount({ token }) {
  ensureLegacyMigration()
  const user = getUserByToken(token)
  if (!user) throw new Error('请先登录')
  return publicUser(user)
}

/* ── HTTP 处理 ── */

function clientId(req, env = process.env) {
  // ★ C-P2.5: 默认不信可伪造的 x-forwarded-for;仅 TRUST_PROXY=1 时采信 XFF 最左 hop。
  return resolveClientId(req, env)
}

export async function handleAuthAccountRequest(req, res, env = process.env) {
  ensureLegacyMigration()
  try {
    const url = new URL(req.url, 'http://localhost')

    if (req.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
      sendJson(res, 200, bootstrapAuth({ token: authToken(req), env }))
      return
    }

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

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = authToken(req)
      const session = token ? getSessionByToken(token) : null
      if (token) deleteSession(token)
      if (session?.user_id) disconnectMcpUser(session.user_id)
      sendJson(res, 200, { ok: true })
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
      sendJson(res, 200, { ok: true, user })
      return
    }


    sendJson(res, 404, { ok: false, error: '接口不存在' })
  } catch (error) {
    // ★ #36: 尊重 readJson 抛的 statusCode (e.g. 413)
    const status = error?.statusCode || 400
    sendJson(res, status, { ok: false, error: error.message || '请求失败' })
  }
}
