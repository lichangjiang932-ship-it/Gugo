import { useCallback, useEffect, useMemo, useRef } from 'react'

const MAX_INPUT_HISTORY = 100

export function getUserInputHistory(messages, limit = MAX_INPUT_HISTORY) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user' && String(message.content || '').trim())
    .slice(-Math.max(1, limit))
    .map((message) => String(message.content))
    .reverse()
}

export function shouldNavigateInputHistory(event, direction, enabled = true) {
  if (!enabled) return false
  if (!event || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const target = event.currentTarget
  if (!target || typeof target.value !== 'string') return false
  if (target.value.trim() !== '' || target.value.includes('\n')) return false
  const start = Number(target.selectionStart)
  const end = Number(target.selectionEnd)
  if (!Number.isFinite(start) || start !== end) return false
  return direction === 'up' || direction === 'down'
}

function canContinueInputHistory(event, input, history, cursor) {
  if (cursor < 0 || input !== history[cursor] || input.includes('\n')) return false
  if (!event || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const target = event.currentTarget
  if (!target || target.value !== input) return false
  const start = Number(target.selectionStart)
  const end = Number(target.selectionEnd)
  return Number.isFinite(start) && start === end
}

export default function useInputHistory({ messages, input, setInput, sessionId, enabled = true }) {
  const history = useMemo(() => getUserInputHistory(messages), [messages])
  const cursorRef = useRef(-1)
  const draftRef = useRef('')

  useEffect(() => {
    cursorRef.current = -1
    draftRef.current = ''
  }, [enabled, sessionId])

  return useCallback((event) => {
    const direction = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null
    if (!direction || !enabled) return false

    let cursor = cursorRef.current
    const continuing = canContinueInputHistory(event, input, history, cursor)
    if (cursor >= 0 && !continuing) {
      cursor = -1
      cursorRef.current = -1
      draftRef.current = ''
    }
    if (!continuing && !shouldNavigateInputHistory(event, direction, enabled)) return false

    if (direction === 'up') {
      if (!history.length) return false
      if (cursor < 0) draftRef.current = input
      cursor = Math.min(cursor + 1, history.length - 1)
      cursorRef.current = cursor
      setInput(history[cursor])
      event.preventDefault()
      return true
    }

    if (cursor < 0) return false
    cursor -= 1
    cursorRef.current = cursor
    setInput(cursor < 0 ? draftRef.current : history[cursor])
    if (cursor < 0) draftRef.current = ''
    event.preventDefault()
    return true
  }, [enabled, history, input, setInput])
}
