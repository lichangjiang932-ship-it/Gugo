import { checkRateLimit, getSessionByToken } from './db.js'
import { z } from 'zod'

/* ── CORS ── */

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin
  // 生产环境应该限制具体域名
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5175', 'http://127.0.0.1:5175']

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  next()
}

/* ── 安全头 ── */

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  // CSP: 生产环境根据实际资源调整
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss: https://api.deepseek.com;"
  )
  next()
}

/* ── 错误边界 ── */

export function errorBoundary(req, res, next) {
  try {
    next()
  } catch (err) {
    console.error('[ERROR]', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' }))
    }
  }
}

/* ── 请求日志 ── */

export function requestLogger(req, res, next) {
  const start = Date.now()
  const originalEnd = res.end.bind(res)
  res.end = (...args) => {
    const duration = Date.now() - start
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode || 200} ${duration}ms`)
    originalEnd(...args)
  }
  next()
}

/* ── Auth 验证 ── */

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }
  const token = auth.slice(7)
  const session = getSessionByToken(token)
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session expired or invalid' }))
    return
  }
  req.userId = session.user_id
  req.token = token
  next()
}

/* ── Rate Limit ── */

export function rateLimit({ keyPrefix, windowMs = 60000, maxRequests = 10 }) {
  return async (req, res, next) => {
    // 生产环境用 IP，本地环境用 token 或 IP
    const clientId = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
    const key = `${keyPrefix}:${clientId}`
    const result = checkRateLimit({ key, windowMs, maxRequests })

    res.setHeader('X-RateLimit-Limit', String(maxRequests))
    res.setHeader('X-RateLimit-Remaining', String(result.remaining))
    if (result.resetAt) {
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
    }

    if (!result.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }))
      return
    }
    next()
  }
}

/* ── 验证码发送限制 ── */

export function loginCodeRateLimit(req, res, next) {
  const clientId = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
  const key = `login_code:${clientId}`
  const result = checkRateLimit({ key, windowMs: 60 * 60 * 1000, maxRequests: 5 }) // 每小时 5 次

  if (!result.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '发送验证码次数过多，请 1 小时后再试。' }))
    return
  }
  next()
}

/* ── 输入校验 ── */

export function validateBody(schema) {
  return (req, res, next) => {
    try {
      req.validatedBody = schema.parse(req.body)
      next()
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid input', details: err.errors }))
        return
      }
      throw err
    }
  }
}

/* ── 常用校验 Schema ── */

export const schemas = {
  email: z.object({
    email: z.string().email('请输入有效的邮箱地址'),
  }),

  verifyCode: z.object({
    email: z.string().email(),
    code: z.string().regex(/^\d{6}$/, '验证码必须是 6 位数字'),
  }),

  sendMessage: z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().max(50000, '消息内容过长'),
    })).min(1),
    modelName: z.string().min(1).max(100),
  }),
}

/* ── Body Parser ── */

export function parseBody(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    next()
    return
  }

  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('application/json')) {
    next()
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > 1e6) {
      req.destroy()
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Payload too large' }))
      return
    }
  })
  req.on('end', () => {
    try {
      req.body = body ? JSON.parse(body) : {}
    } catch {
      req.body = {}
    }
    next()
  })
}
