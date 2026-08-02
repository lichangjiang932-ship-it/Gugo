import { useCallback, useEffect, useMemo, useRef } from 'react'

const MAX_INPUT_HISTORY = 100

export function getUserInputHistory(messages, limit = MAX_INPUT_HISTORY) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user' && String(message.content || '').trim())
    .slice(-Math.max(1, limit))
    .map((message) => String(message.content))
    .reverse()
}

export function shouldNavigateInputHistory(event, direction) {
  if (!event || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const target = event.currentTarget
  if (!target || typeof target.value !== 'string') return false
  const start = Number(target.selectionStart)
  const end = Number(target.selectionEnd)
  if (!Number.isFinite(start) || start !== end) return false
  if (direction === 'up') return !target.value.slice(0, start).includes('\n')
  if (direction === 'down') return !target.value.slice(end).includes('\n')
  return false
}

export default function useInputHistory({ messages, input, setInput, sessionId }) {
  const history = useMemo(() => getUserInputHistory(messages), [messages])
  const cursorRef = useRef(-1)
  const draftRef = useRef('')

  useEffect(() => {
    cursorRef.current = -1
    draftRef.current = ''
  }, [sessionId])

  return useCallback((event) => {
    const direction = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null
    if (!direction || !shouldNavigateInputHistory(event, direction)) return false

    let cursor = cursorRef.current
    if (cursor >= 0 && input !== history[cursor]) cursor = -1

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
    event.preventDefault()
    return true
  }, [history, input, setInput])
}
