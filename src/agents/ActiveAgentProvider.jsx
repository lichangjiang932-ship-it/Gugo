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

const STORAGE_KEY = 'yma:activeAgentId'

function readInitial() {
  if (typeof window === 'undefined') return null
  try { return window.localStorage?.getItem(STORAGE_KEY) || null } catch { return null }
}

export function ActiveAgentProvider({ children }) {
  const [activeAgentId, setActiveAgentIdState] = useState(readInitial)
  const [agents, setAgents] = useState([])
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

  // v0.7：跨标签页同步。另一个 tab 改了 active agent 后，这边自动跳。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return
      const next = e.newValue || null
      setActiveAgentIdState(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // activeAgentId 变了（跨 tab 或手工）同步重选 activeAgent
  // 派生状态：activeAgent 从 (activeAgentId, agents) 计算，避免 effect setState cascade
  const computedActiveAgent = useMemo(() => {
    if (!agents.length) return null
    return agents.find((a) => a.id === activeAgentId)
      || agents.find((a) => a.isDefault)
      || agents[0]
      || null
  }, [activeAgentId, agents])

  const value = useMemo(() => ({
    activeAgentId: computedActiveAgent?.id || null,
    activeAgent: computedActiveAgent,
    agents,
    loading,
    setActiveAgentId,
    refresh,
  }), [computedActiveAgent, agents, loading, setActiveAgentId, refresh])

  return <ActiveAgentContext.Provider value={value}>{children}</ActiveAgentContext.Provider>
}

