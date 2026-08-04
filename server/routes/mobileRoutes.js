/**
 * Mobile Access Keys 路由 (Hanako 平行：手机/LAN access key)
 *
 *   GET    /api/mobile/access-keys              - 列出当前用户的 key（不含明文）
 *   POST   /api/mobile/access-keys              - 创建 { label?, ttlMs? } → 返回 rawKey（show-once）
 *   DELETE /api/mobile/access-keys/:id          - 撤销
 *   POST   /api/mobile/handshake                - { key } → 换登录 token（同 /api/auth/verify 形态）
 */

import { randomBytes } from 'node:crypto'
import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { resolveClientId } from '../utils/loginGuard.js'
import { hashArgs, writeToolAudit } from '../utils/audit.js'
import {
  listMobileKeys,
  createMobileKey,
  revokeMobileKey,
  verifyAccessKey,
} from '../services/mobileAccessKeyStore.js'
import { checkRateLimit, createSession, getUserById } from '../db.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: '请先登录' })
}

function auditHandshake({ clientId, userId = null, keyId = null, status }) {
  writeToolAudit({
    userId: userId || `mobile-anonymous:${hashArgs(clientId) || 'unknown'}`,
    origin: 'mobile',
    toolName: 'mobile_handshake',
    serverId: keyId,
    args: { clientId },
    status,
  })
}

export async function handleMobileRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    // 公共：handshake 不需要 bearer，凭 access key 换 token
    if (req.method === 'POST' && pathname === '/api/mobile/handshake') {
      const clientId = resolveClientId(req)
      const maxRequests = Math.max(1, Math.min(60, Number(process.env.MOBILE_HANDSHAKE_RATE_MAX) || 10))
      const windowMs = 15 * 60 * 1000
      const rate = checkRateLimit({
        key: `mobile_handshake:${clientId}`,
        windowMs,
        maxRequests,
      })
      res.setHeader?.('X-RateLimit-Limit', String(maxRequests))
      res.setHeader?.('X-RateLimit-Remaining', String(rate.remaining))
      if (!rate.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))
        res.setHeader?.('Retry-After', String(retryAfter))
        auditHandshake({ clientId, status: 'denied' })
        return sendJson(res, 429, { ok: false, error: '握手失败次数过多，请稍后再试' })
      }
      const body = await readJson(req)
      const rawKey = body?.key
      if (!rawKey) {
        auditHandshake({ clientId, status: 'denied' })
        return sendJson(res, 400, { ok: false, error: '缺少 key' })
      }
      const result = verifyAccessKey(rawKey)
      if (!result) {
        auditHandshake({ clientId, status: 'denied' })
        return sendJson(res, 401, { ok: false, error: 'key 无效或已过期' })
      }
      const user = getUserById(result.userId)
      if (!user) {
        auditHandshake({ clientId, userId: result.userId, keyId: result.keyId, status: 'denied' })
        return sendJson(res, 401, { ok: false, error: '账户不存在' })
      }
      const token = 'tkn_' + randomBytes(24).toString('hex')
      createSession({ token, userId: user.id })
      auditHandshake({ clientId, userId: user.id, keyId: result.keyId, status: 'ok' })
      return sendJson(res, 200, {
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          hasPassword: !!user.password_hash,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
        keyId: result.keyId,
      })
    }

    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)

    if (req.method === 'GET' && pathname === '/api/mobile/access-keys') {
      const keys = listMobileKeys({ userId })
      return sendJson(res, 200, { ok: true, keys })
    }

    if (req.method === 'POST' && pathname === '/api/mobile/access-keys') {
      const body = await readJson(req)
      const { record, rawKey } = createMobileKey({
        userId,
        label: body?.label || '',
        ttlMs: body?.ttlMs || null,
      })
      return sendJson(res, 200, { ok: true, key: record, rawKey })
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/mobile/access-keys/')) {
      const id = pathname.slice('/api/mobile/access-keys/'.length)
      if (!id || id.includes('/')) return sendJson(res, 400, { ok: false, error: '缺少 id' })
      const ok = revokeMobileKey({ userId, id })
      if (!ok) return sendJson(res, 404, { ok: false, error: 'key 不存在或已撤销' })
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
