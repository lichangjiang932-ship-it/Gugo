import { createContext, useContext } from 'react'

export const ActiveAgentContext = createContext(null)

export function useActiveAgent() {
  const ctx = useContext(ActiveAgentContext)
  if (!ctx) throw new Error('useActiveAgent must be used inside ActiveAgentProvider')
  return ctx
}
