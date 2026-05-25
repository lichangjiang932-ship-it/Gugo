/**
 * 阶段 5: 当前活跃 Agent context。
 *
 * - localStorage 持久化
 * - 启动时从 /api/agents 拉一次，本地 id 不在列表里则 fallback default
 * - 提供 setActiveAgentId / activeAgent / refresh
 *
 * 本阶段不做多 session 维度记忆（所有 session 共享一个当前 agent）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listAgentsApi, getDefaultAgentApi } from '../lib/agentClient.js'
import { ActiveAgentContext } from './activeAgentContext.js'

const STORAGE_KEY = '***'

function readInitial() {
  if (typeof window === 'undefined') return null
  try { return window.localStorage?.getItem(STORAGE_KEY) || null } catch { return null }
}

export function ActiveAgentProvider({ children }) {
  const [activeAgentId, setActiveAgentIdState] = useState(readInitial)
  const [agents, setAgents] = useState([])
  const [activeAgent, setActiveAgent] = useState(null)
  const [loading, setLoading] = useState(false)

  const setActiveAgentId = useCallback((id) => {
    setActiveAgentIdState(id || null)
    try {
      if (id) window.localStorage?.setItem(STORAGE_KEY, id)
      else window.localStorage?.removeItem(STORAGE_KEY)
    } catch { /* ignore */ }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listAgentsApi().catch(() => ({ agents: [] }))
      let arr = list.agents || []
      if (arr.length === 0) {
        try {
          const def = await getDefaultAgentApi()
          if (def?.agent) arr = [def.agent]
        } catch { arr = [] }
      }
      setAgents(arr)
      const pick = arr.find((a) => a.id === activeAgentId)
        || arr.find((a) => a.isDefault)
        || arr[0]
        || null
      setActiveAgent(pick)
      if (pick && pick.id !== activeAgentId) setActiveAgentId(pick.id)
      if (!pick) setActiveAgentId(null)
    } finally {
      setLoading(false)
    }
  }, [activeAgentId, setActiveAgentId])

  useEffect(() => {
    const t = window.setTimeout(() => { refresh() }, 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo(() => ({
    activeAgentId: activeAgent?.id || null,
    activeAgent,
    agents,
    loading,
    setActiveAgentId,
    refresh,
  }), [activeAgent, agents, loading, setActiveAgentId, refresh])

  return <ActiveAgentContext.Provider value={value}>{children}</ActiveAgentContext.Provider>
}

