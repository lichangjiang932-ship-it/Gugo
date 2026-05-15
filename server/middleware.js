import { checkRateLimit, getSessionByToken } from './db.js'
import { z } from 'zod'

/* ── CORS ── */

// 解析允许源:
//   · ALLOWED_ORIGINS=https://a.example.com,https://b.example.com  → 精确匹配
//   · 没设 + NODE_ENV=production → 同源 only (不发 CORS 头,浏览器同源仍走得通)
//   · 没设 + NODE_ENV!=production → 本地默认列表
function getAllowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (process.env.NODE_ENV === 'production') {
    // 生产没显式配 → 不允许任何跨域 (返回空数组,下面的 allowedOrigins.includes(origin) 永假)
    return []
  }
  return ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5175', 'http://127.0.0.1:5175']
}

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin
  const allowedOrigins = getAllowedOrigins()

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    // 预检请求:同源(没 origin 头)放行,跨源且不在白名单 → 403
    if (origin && !allowedOrigins.includes(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'CORS origin not allowed' }))
      return
    }
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
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  // HSTS:仅 HTTPS 上才发
  if (process.env.NODE_ENV === 'production' && (req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted)) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }
  // CSP:
  //   · script-src 不再放 unsafe-eval (Vite 构建的产物不需要)
  //   · 仍保留 unsafe-inline 兼容 React 内联事件;后续可改用 nonce
  //   · connect-src 默认只放 self + DeepSeek;额外模型端点通过 ALLOWED_MODEL_ENDPOINTS 注入
  const extraConnect = (process.env.ALLOWED_MODEL_ENDPOINTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).join(' ')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' blob:",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      `connect-src 'self' ws: wss: https://api.deepseek.com ${extraConnect}`.trim(),
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  )
  next()
}

/* ── 错误边界 ── */

export function errorBoundary(req, res, next) {
  try {
    const result = next()
    // 捕获异步 Promise rejection
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        console.error('[ERROR]', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error' }))
        }
      })
    }
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
    if (process.env.NODE_ENV !== 'production') console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode || 200} ${duration}ms`)
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
