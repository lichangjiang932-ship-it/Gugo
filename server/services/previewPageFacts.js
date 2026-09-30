import { randomUUID } from 'node:crypto'

/**
 * Page facts travelling between the backend and the window that can see the page.
 *
 * The backend cannot screenshot or read the docked view: the view belongs to the
 * Electron main process, and the only process allowed to talk to it is the app's
 * own renderer. So a request is parked here with an id, the renderer picks it up
 * while it polls the preview state, performs it against the live page, and posts
 * the result back. Both directions are authenticated HTTP from the same window
 * that already drives the panel.
 *
 * Every request is bounded in time and in number: a window that is closed, or a
 * panel nobody opened, ends as a clear timeout rather than a tool call that never
 * returns.
 */

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 120_000
const MAX_PENDING_PER_WORKSPACE = 4
const MAX_FACTS_PER_REQUEST = 8

const pending = new Map()

// When a window last asked about this workspace. Page facts can only come from a
// window, so asking before one has spoken is asking the dark.
const seen = new Map()
const WINDOW_PRESENT_MS = 15_000

function scopeKey(userId, workspaceRoot) {
  return `${String(userId || '')}\u0000${String(workspaceRoot || '')}`
}

/** The window that polls the preview state is the one that can read the page. */
export function markPreviewWindowSeen({ userId, workspaceRoot, now = Date.now() } = {}) {
  seen.set(scopeKey(userId, workspaceRoot), now)
  return now
}

export function isPreviewWindowPresent({ userId, workspaceRoot, withinMs = WINDOW_PRESENT_MS, now = Date.now() } = {}) {
  const at = seen.get(scopeKey(userId, workspaceRoot))
  return Number.isFinite(at) && (now - at) <= withinMs
}

export function listPendingPageFacts({ userId, workspaceRoot } = {}) {
  const key = scopeKey(userId, workspaceRoot)
  const requests = []
  for (const entry of pending.values()) {
    if (entry.key === key) requests.push({ id: entry.id, ops: entry.ops })
  }
  return requests
}

/** How many requests this workspace is waiting on — the panel's busy signal. */
export function countPendingPageFacts({ userId, workspaceRoot } = {}) {
  return listPendingPageFacts({ userId, workspaceRoot }).length
}

/**
 * Take a result from the window.
 *
 * The id has to name a request that is still waiting *for this same scope*: a
 * result that arrives late, or from another user's workspace, is dropped rather
 * than delivered to whoever happens to be waiting now.
 */
export function resolvePageFacts({ userId, workspaceRoot, id, result } = {}) {
  const entry = pending.get(String(id || ''))
  if (!entry || entry.key !== scopeKey(userId, workspaceRoot)) return { ok: true, matched: false }
  pending.delete(entry.id)
  clearTimeout(entry.timer)
  entry.resolve({ ok: true, results: result?.results || [], errors: result?.errors || [] })
  return { ok: true, matched: true }
}

/** Give up on everything this scope is waiting for — a cancelled turn, above all. */
export function cancelPendingPageFacts({ userId, workspaceRoot = null, reason = 'cancelled' } = {}) {
  let cancelled = 0
  for (const entry of [...pending.values()]) {
    if (entry.userId !== userId) continue
    if (workspaceRoot && entry.workspaceRoot !== workspaceRoot) continue
    pending.delete(entry.id)
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, code: 'PREVIEW_FACTS_CANCELLED', error: reason })
    cancelled += 1
  }
  return cancelled
}

function normalizeOps(ops) {
  const list = Array.isArray(ops) ? ops.slice(0, MAX_FACTS_PER_REQUEST) : []
  return list.filter((op) => op && typeof op === 'object' && typeof op.kind === 'string')
}

/**
 * Ask the window for page facts and wait for the answer.
 *
 * A second request while one is in flight is refused: the reader is looking at
 * one page, and queueing a burst of screenshots would only delay the first.
 */
export function requestPageFacts({ userId, workspaceRoot, ops, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  const normalized = normalizeOps(ops)
  if (!normalized.length) {
    return Promise.resolve({ ok: false, code: 'PREVIEW_FACTS_EMPTY', error: '没有要读取的内容' })
  }
  if (countPendingPageFacts({ userId, workspaceRoot }) >= MAX_PENDING_PER_WORKSPACE) {
    return Promise.resolve({ ok: false, code: 'PREVIEW_FACTS_BUSY', error: '预览面板正忙，请稍后重试' })
  }
  if (signal?.aborted) return Promise.resolve({ ok: false, code: 'PREVIEW_ABORTED', error: '已取消' })

  const id = randomUUID()
  const waitMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  return new Promise((resolve) => {
    const entry = {
      id,
      key: scopeKey(userId, workspaceRoot),
      userId,
      workspaceRoot: String(workspaceRoot || ''),
      ops: normalized,
      createdAt: Date.now(),
      timer: null,
      resolve: (value) => {
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      },
    }
    const onAbort = () => {
      if (!pending.has(id)) return
      pending.delete(id)
      clearTimeout(entry.timer)
      resolve({ ok: false, code: 'PREVIEW_ABORTED', error: '已取消' })
    }
    // Deliberately not unref'd: the whole point of this timer is that a tool call
    // waiting on a panel that never answers still ends, and an unref'd timer on an
    // idle event loop is a promise that never settles.
    entry.timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      resolve({
        ok: false,
        code: 'PREVIEW_FACTS_TIMEOUT',
        error: '预览面板没有回应：请打开侧边栏的预览面板，或在桌面版中使用',
      })
    }, waitMs)
    pending.set(id, entry)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export const _testing = { MAX_PENDING_PER_WORKSPACE, pending, scopeKey }
