import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createStarterPreviewConfig,
  readPreviewState,
  restartPreviewServer,
  setPreviewAutoVerify,
  startPreviewServer,
  stopPreviewServer,
} from '../../../lib/previewClient.js'
import { createFactsRelay } from '../../../lib/previewFactRunner.js'

const POLL_INTERVAL_MS = 2_000

/**
 * The workspace's preview server, as the panel sees it.
 *
 * The server owns the process; this polls its state while the preview tab is on
 * screen and stops polling when it is not, so a backgrounded panel costs nothing.
 * Failures are kept as data rather than thrown: the panel shows what the server
 * refused (no grant, no shell, no config) next to the button that tried.
 */
export default function usePreviewServer({ active = true, workspaceRoot = '' } = {}) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const apply = useCallback((next) => {
    if (mountedRef.current && next) setState(next)
    return next
  }, [])

  const relayFacts = useMemo(() => createFactsRelay(), [])

  const refresh = useCallback(async () => {
    if (!workspaceRoot) {
      apply(null)
      return null
    }
    try {
      const next = apply(await readPreviewState({ workspaceRoot }))
      // The backend parks page-fact requests where this poll can find them: it
      // cannot see the page, and this window is the only one that can.
      if (next?.pendingFacts?.length) {
        void relayFacts({ workspaceRoot, requests: next.pendingFacts })
      }
      return next
    } catch (caught) {
      if (mountedRef.current) setError({ code: caught?.code || 'PREVIEW_STATE_FAILED', message: caught?.message || String(caught) })
      return null
    }
  }, [apply, relayFacts, workspaceRoot])

  useEffect(() => {
    if (!active || !workspaceRoot) return undefined
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, refresh, workspaceRoot])

  const run = useCallback(async (label, action) => {
    setBusy(label)
    setError(null)
    try {
      return apply(await action())
    } catch (caught) {
      if (mountedRef.current) setError({ code: caught?.code || 'PREVIEW_ACTION_FAILED', message: caught?.message || String(caught) })
      return null
    } finally {
      if (mountedRef.current) setBusy('')
    }
  }, [apply])

  const start = useCallback((name = '') => run('start', () => startPreviewServer({ workspaceRoot, name })), [run, workspaceRoot])
  const stop = useCallback(() => run('stop', () => stopPreviewServer({ workspaceRoot })), [run, workspaceRoot])
  const restart = useCallback((name = '') => run('restart', () => restartPreviewServer({ workspaceRoot, name })), [run, workspaceRoot])
  const setup = useCallback(() => run('setup', () => createStarterPreviewConfig({ workspaceRoot })), [run, workspaceRoot])
  const setAutoVerify = useCallback((autoVerify) => run('auto-verify', () => setPreviewAutoVerify({ workspaceRoot, autoVerify })), [run, workspaceRoot])

  return { busy, error, refresh, restart, setAutoVerify, setup, start, state, stop }
}
