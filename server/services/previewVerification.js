import { readPreviewConfig } from './previewConfig.js'
import { isPreviewWindowPresent, requestPageFacts } from './previewPageFacts.js'
import { readPreviewServerState, startPreviewServer, waitForPreviewServer } from './previewServerStore.js'

/**
 * The automatic verification loop: edit a file, look at the running app, and let
 * the model decide whether the edit worked.
 *
 * It runs once per mutation batch rather than as its own loop. The model already
 * loops — it edits, reads what came back, and edits again — so the observation is
 * attached to the edit's own tool result: the screenshot becomes the vision input
 * that result already supports, and the page facts become part of what the model
 * reads before its next decision. That keeps one loop in the system instead of
 * two that could disagree.
 *
 * Nothing here can fail the turn. A project without a preview configuration, a
 * server that will not start, a panel nobody opened: each ends as a line the
 * model reads, not as an exception in the middle of a batch.
 */

export const MAX_VERIFY_ROUNDS = 5

const READY_TIMEOUT_MS = 30_000
const FACTS_TIMEOUT_MS = 20_000
const bySession = new Map()

/** One conversation, one round counter — read here and from the panel alike. */
export function previewVerificationKey({ userId = '', sessionId = '', workspaceRoot = '' } = {}) {
  return `${userId}\u0000${sessionId || workspaceRoot}`
}

function roundState(scopeKey) {
  const existing = bySession.get(scopeKey)
  if (existing) return existing
  const created = { rounds: 0, active: false, lastUrl: '', lastError: '', startedAt: 0 }
  bySession.set(scopeKey, created)
  return created
}

/** What the panel shows while a verification is in flight. */
export function previewVerificationStatus(scope = {}) {
  const state = bySession.get(previewVerificationKey(scope))
  if (!state) return { active: false, rounds: 0, url: '', error: '' }
  return { active: state.active, rounds: state.rounds, url: state.lastUrl, error: state.lastError }
}

export function resetPreviewVerification(scope = {}) {
  if (scope.sessionId || scope.workspaceRoot) bySession.delete(previewVerificationKey(scope))
  else bySession.clear()
}

function observationText({ url, server, consoleEntries, dom, screenshotTaken }) {
  const errors = consoleEntries.filter((entry) => entry.level === 'error')
  const warnings = consoleEntries.filter((entry) => entry.level === 'warning')
  const lines = [
    `[preview] ${url || '(no page)'} · server ${server?.status || 'unknown'}${screenshotTaken ? ' · screenshot attached' : ''}`,
    `[preview] console: ${errors.length} error(s), ${warnings.length} warning(s)`,
  ]
  for (const entry of [...errors, ...warnings].slice(0, 8)) {
    lines.push(`[preview]   [${entry.level}] ${String(entry.message || '').slice(0, 300)}`)
  }
  if (dom && typeof dom === 'object') {
    lines.push(`[preview] page: "${String(dom.title || '').slice(0, 120)}"`)
    if (dom.emptyRoot === true || dom.hasVisibleContent === false) {
      lines.push('[preview] the page looks empty: nothing visible rendered')
    }
  }
  lines.push('If the screenshot or the console shows a problem, fix it and edit again; otherwise continue.')
  return lines.join('\n')
}

/**
 * One verification for one mutation batch.
 *
 * `settle` is what the batch waits on before it hands the model its results, so
 * the observation always belongs to the same round as the edit that caused it.
 */
export function createPreviewVerification({ userId = null, sessionId = '', workspaceRoot = '', signal = null } = {}) {
  const state = workspaceRoot ? roundState(previewVerificationKey({ userId, sessionId, workspaceRoot })) : null
  let pending = null

  function skipped(reason) {
    return { ok: false, skipped: true, reason }
  }

  async function verify() {
    state.rounds += 1
    state.active = true
    state.startedAt = Date.now()
    try {
      const running = readPreviewServerState({ userId, workspaceRoot })
      if (running.status !== 'ready') {
        const started = await startPreviewServer({ userId, workspaceRoot })
        if (!started.ok) {
          state.lastError = started.error || 'preview server did not start'
          return { ok: false, error: state.lastError }
        }
        const ready = await waitForPreviewServer({ userId, workspaceRoot, timeoutMs: READY_TIMEOUT_MS, signal })
        if (!ready.ok) {
          state.lastError = ready.error || 'preview server never became ready'
          return { ok: false, error: state.lastError, log: String(ready.log || '').slice(-600) }
        }
      }
      const server = readPreviewServerState({ userId, workspaceRoot })
      state.lastUrl = server.url || ''
      const answer = await requestPageFacts({
        userId,
        workspaceRoot,
        ops: [{ kind: 'screenshot' }, { kind: 'dom' }, { kind: 'console' }],
        timeoutMs: FACTS_TIMEOUT_MS,
        signal,
      })
      if (!answer.ok) {
        state.lastError = answer.error || 'page facts unavailable'
        return { ok: false, error: state.lastError }
      }
      const shot = (answer.results || []).find((entry) => entry.kind === 'screenshot')
      const domEntry = (answer.results || []).find((entry) => entry.kind === 'dom')
      const consoleEntry = (answer.results || []).find((entry) => entry.kind === 'console')
      let dom = null
      try {
        dom = domEntry?.result ? JSON.parse(domEntry.result) : null
      } catch { /* a page that returned something unparseable still has a screenshot */ }
      const consoleEntries = consoleEntry?.entries || []
      state.lastError = ''
      return {
        ok: true,
        url: server.url || '',
        status: server.status || '',
        screenshot: shot?.ok && typeof shot.dataUrl === 'string' ? shot.dataUrl.split(',')[1] || '' : '',
        dom,
        consoleEntries,
      }
    } finally {
      state.active = false
    }
  }

  return {
    /**
     * Called right after a successful edit. Never throws and never blocks: the
     * batch waits at `settle`, where a slow page cannot cancel the turn.
     */
    observe({ result = null, onMessage = null } = {}) {
      if (!state || !workspaceRoot) return skipped('no-workspace')
      // Read the project's answer before starting any work: most projects have no
      // preview, and a promise that exists only to find that out is a promise the
      // batch then waits on for nothing.
      const read = readPreviewConfig({ workspaceRoot })
      if (read.missing || !read.config) return skipped('no-config')
      if (read.config.autoVerify !== true) return skipped('disabled')
      // Reading the page needs the panel that shows it. Without a window asking,
      // the work would end as a timeout on the reader's own turn.
      if (!isPreviewWindowPresent({ userId, workspaceRoot })) {
        onMessage?.('[preview] verification skipped: no preview panel is open in this session.')
        return skipped('no-window')
      }
      if (state.rounds >= MAX_VERIFY_ROUNDS) {
        onMessage?.(`[preview] automatic verification stopped after ${MAX_VERIFY_ROUNDS} rounds. 自动验证未通过，请人工检查。`)
        return skipped('rounds-exhausted')
      }
      if (pending) return skipped('in-flight')
      pending = verify().then((outcome) => {
        if (result && outcome?.ok) {
          if (outcome.screenshot) result.image = { data: outcome.screenshot, mimeType: 'image/png' }
          result.preview = {
            url: outcome.url,
            server: outcome.status,
            console: outcome.consoleEntries.slice(0, 40),
            dom: outcome.dom,
          }
        }
        onMessage?.(observationText({
          url: outcome?.url,
          server: { status: outcome?.status },
          consoleEntries: outcome?.consoleEntries || [],
          dom: outcome?.dom,
          screenshotTaken: Boolean(outcome?.screenshot),
        }))
        if (outcome && outcome.ok === false) {
          onMessage?.(`[preview] verification could not run: ${outcome.error}${outcome.log ? `\n${outcome.log}` : ''}`)
        }
        return outcome
      }).catch((error) => skipped(error?.message || 'verify-failed'))
      return { ok: true, started: true }
    },

    /** Wait for the observation to be ready — bounded by the work's own timeouts. */
    async settle() {
      if (!pending) return null
      const current = pending
      pending = null
      return current
    },
  }
}
