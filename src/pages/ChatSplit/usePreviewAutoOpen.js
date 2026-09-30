import { useEffect } from 'react'

import { readPreviewState } from '../../lib/previewClient.js'

const POLL_INTERVAL_MS = 2_500

/**
 * Show the preview when the agent is verifying through it.
 *
 * The backend can start the server and ask for a screenshot, but the page itself
 * lives in the panel — so a verification nobody opened would time out on the one
 * thing it needed: a window. While a turn is running this asks the backend
 * whether a verification is in flight, and opens the panel when it is.
 *
 * It runs only while the turn is generating: an idle conversation has nothing to
 * verify, and the panel keeps its own poll once it is open.
 */
export default function usePreviewAutoOpen({ active = false, onOpen, sessionId = '', workspaceRoot = '', readState = readPreviewState } = {}) {
  useEffect(() => {
    if (!active || !workspaceRoot || typeof onOpen !== 'function') return undefined
    let cancelled = false
    let opened = false
    const tick = async () => {
      if (cancelled || opened) return
      try {
        const state = await readState({ workspaceRoot, sessionId })
        if (!cancelled && state?.verify?.active) {
          opened = true
          onOpen()
        }
      } catch {
        // The panel is a convenience here: a failed poll must never disturb the turn.
      }
    }
    const timer = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, onOpen, readState, sessionId, workspaceRoot])
}
