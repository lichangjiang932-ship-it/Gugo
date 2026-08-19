/**
 * 一次性短 TTL SSE ticket (C-P2.1)。
 *
 * EventSource 无法带 Authorization 头,旧实现把 7 天 session token 放 URL query,
 * 会落入 nginx access 日志 / Referer / 浏览器历史,泄露即接管会话。
 *
 * 改为:前端用 header token 调 POST /api/jobs/stream-ticket 换一个 60s 一次性 ticket,
 * EventSource 用 ?ticket= 连接;服务端校验后立即作废。即便 ticket 落日志,
 * 60s 内且仅一次可用,大幅缩小泄露面。
 *
 * 进程内存级 Map(单进程足够;多 worker 需上 Redis,与 rateLimiter 同注)。
 */
import crypto from 'node:crypto'

const TICKET_TTL_MS = 60 * 1000
const MAX_PENDING_TICKETS = 4096

// ticket → { userId, scope, expiresAt }
const tickets = new Map()

function normalizedScope(scope) {
  const value = String(scope || '').trim()
  return value || null
}

function pruneTickets(issuedAt) {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= issuedAt) tickets.delete(ticket)
  }

  while (tickets.size >= MAX_PENDING_TICKETS) {
    const oldestTicket = tickets.keys().next().value
    if (!oldestTicket) break
    tickets.delete(oldestTicket)
  }
}

export function createStreamTicket(userId, {
  now = Date.now,
  ttlMs = TICKET_TTL_MS,
  scope = null,
} = {}) {
  if (!userId) throw new Error('userId 必填')
  const issuedAt = now()
  pruneTickets(issuedAt)
  const ticket = `st_${crypto.randomBytes(24).toString('hex')}`
  tickets.set(ticket, {
    userId,
    scope: normalizedScope(scope),
    expiresAt: issuedAt + ttlMs,
  })
  return ticket
}

export function consumeStreamTicket(ticket, { now = Date.now, scope = null } = {}) {
  if (typeof ticket !== 'string' || !ticket) return null
  const entry = tickets.get(ticket)
  if (!entry) return null
  // 一次性:无论是否过期或 scope 不匹配,取出即删。
  tickets.delete(ticket)
  if (entry.expiresAt <= now()) return null
  if (entry.scope !== normalizedScope(scope)) return null
  return entry.userId
}

// 测试用:清空所有 ticket
export function _clearStreamTickets() {
  tickets.clear()
}

// 测试用:验证过期清扫与容量上限，不暴露 ticket 内容。
export function _getStreamTicketCount() {
  return tickets.size
}

export const _MAX_PENDING_TICKETS = MAX_PENDING_TICKETS
