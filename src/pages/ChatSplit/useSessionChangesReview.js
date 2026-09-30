import { useCallback, useMemo, useState } from 'react'

import { countRecordedEditLines, sessionFileChanges, sessionFileEditIndex } from '../../lib/sessionChanges.js'

/**
 * The conversation's change review: how many files this session's tool calls
 * changed, and — once the reader opens it — the per-file breakdown behind that
 * number.
 *
 * Read from the same tool calls the message rows render, so the indicator can
 * never disagree with what the conversation already shows. The panel's contents
 * are only computed while it is open; the count is what the header shows.
 *
 * A file row opens that file's recorded diff in the main area: the panel is the
 * index, the main area is where a diff is read. The artifact it hands over is
 * built here, beside the index that produced it, so the two show the same edits.
 */
export default function useSessionChangesReview({ messages, onOpen = null, onOpenDiff = null, workspacePath = '' }) {
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

  const openDiff = useCallback((file, edits) => {
    if (!onOpenDiff || !file) return
    const counts = file.reported || countRecordedEditLines(edits)
    onOpenDiff({
      messageId: 'session-changes',
      preview: {
        type: 'diff',
        filename: file.displayPath,
        label: 'DIFF',
        path: file.path || file.displayPath,
        summary: `+${counts.additions} −${counts.deletions}`,
        hunks: Array.isArray(edits) ? edits : [],
      },
    })
  }, [onOpenDiff])

  return { changes, close, count, editIndex, open, openDiff, toggle, visible }
}
