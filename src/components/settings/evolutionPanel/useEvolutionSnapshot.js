import { useCallback, useEffect, useState } from 'react'
import {
  listEvolutionApprovalsApi,
  listEvolutionCanariesApi,
  listEvolutionCandidatesApi,
  listEvolutionEvaluationsApi,
  listEvolutionEvidenceApi,
  listEvolutionPromotionsApi,
} from '../../../lib/evolutionClient.js'
import { listModelProviders } from '../../../lib/modelClient.js'
import { actionMessage } from './evolutionUtils.js'

const EMPTY_SNAPSHOT = Object.freeze({
  evidence: [],
  candidates: [],
  evaluations: [],
  approvals: [],
  canaries: [],
  promotions: [],
  providers: [],
})

export async function loadEvolutionSnapshot() {
  const [evidence, candidates, evaluations, approvals, canaries, promotions, providers] = await Promise.all([
    listEvolutionEvidenceApi({ limit: 25 }),
    listEvolutionCandidatesApi({ limit: 20 }),
    listEvolutionEvaluationsApi({ limit: 20 }),
    listEvolutionApprovalsApi({ limit: 20 }),
    listEvolutionCanariesApi({ limit: 20 }),
    listEvolutionPromotionsApi({ limit: 20 }),
    listModelProviders().catch(() => ({ providers: [] })),
  ])
  return {
    evidence: evidence.evidence || [],
    candidates: candidates.candidates || [],
    evaluations: evaluations.evaluations || [],
    approvals: approvals.approvals || [],
    canaries: canaries.canaries || [],
    promotions: promotions.promotions || [],
    providers: (providers.providers || []).filter((provider) => provider.enabled),
  }
}

export default function useEvolutionSnapshot(t) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await loadEvolutionSnapshot())
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    let active = true
    void loadEvolutionSnapshot()
      .then((nextSnapshot) => {
        if (!active) return
        setSnapshot(nextSnapshot)
        setMessage('')
      })
      .catch((error) => {
        if (active) setMessage(actionMessage(error, t))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [t])

  return {
    busy,
    loading,
    message,
    refresh,
    setBusy,
    setMessage,
    setSnapshot,
    snapshot,
  }
}
