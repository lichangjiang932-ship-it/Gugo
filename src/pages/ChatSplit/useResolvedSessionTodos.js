import { useMemo } from 'react'
import { resolveSessionTodos } from '../../lib/sessionTodos.js'

/** The live task list: stored state first, transcript fallback for a reload. */
export default function useResolvedSessionTodos({ messages, storedTodos }) {
  return useMemo(
    () => resolveSessionTodos({ messages, storedTodos }),
    [messages, storedTodos],
  )
}
