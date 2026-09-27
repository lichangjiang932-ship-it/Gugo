import { useCallback, useMemo, useState } from 'react'

import { sessionFileChanges, sessionFileEditIndex } from '../../lib/sessionChanges.js'

/**
 * The conversation's change review: how many files this session's tool calls
 * changed, and — once the reader opens it — the per-file breakdown behind that
 * number.
 *
 * Read from the same tool calls the message rows render, so the indicator can
 * never disagree with what the conversation already shows. The panel's contents
 * are only computed while it is open; the count is what the header shows.
 */
export default function useSessionChangesReview({ messages, onOpen = null, workspacePath = '' }) {
  const [visible, setVisible] = useState(false)
  const scope = useMemo(() => ({ workspacePath }), [workspacePath])
  const count = useMemo(() => sessionFileChanges(messages, scope).totals.files, [messages, scope])
  const changes = useMemo(
    () => (visible ? sessionFileChanges(messages, scope) : null),
    [visible, messages, scope],
  )
  const editIndex = useMemo(
    () => (visible ? sessionFileEditIndex(messages, scope) : null),
    [visible, messages, scope],
  )

  const open = useCallback(() => {
    // Another panel wants the same corner of the screen; opening this one is the
    // reader saying which they mean.
    onOpen?.()
    setVisible(true)
  }, [onOpen])
  const close = useCallback(() => setVisible(false), [])
  const toggle = useCallback(() => {
    setVisible((current) => {
      if (!current) onOpen?.()
      return !current
    })
  }, [onOpen])

  return { changes, close, count, editIndex, open, toggle, visible }
}
