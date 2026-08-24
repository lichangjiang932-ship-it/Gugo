import { useMemo, useState } from 'react'
import {
  createEvolutionCanaryApi,
  createEvolutionCanaryGraderPolicyApi,
  createEvolutionCanaryRollbackPolicyApi,
  getEvolutionCanaryOnlineGradesApi,
  runEvolutionCanaryOnlineGradeApi,
  startEvolutionCanaryApi,
  stopEvolutionCanaryApi,
} from '../../../lib/evolutionClient.js'
import {
  actionMessage,
  DEFAULT_CANARY_DRAFT,
  DEFAULT_ONLINE_GRADER_POLICY,
  DEFAULT_ROLLBACK_POLICY,
} from './evolutionUtils.js'
import { loadEvolutionSnapshot } from './useEvolutionSnapshot.js'

export default function useEvolutionCanary({
  refresh,
  setBusy,
  setMessage,
  setSnapshot,
  snapshot,
  t,
}) {
  const [canaryDraft, setCanaryDraft] = useState({ ...DEFAULT_CANARY_DRAFT })
  const [onlineGradeStates, setOnlineGradeStates] = useState({})
  const approved = useMemo(
    () => snapshot.approvals.filter((item) => item.decision === 'approved'),
    [snapshot.approvals],
  )

  const graderPolicyInput = () => ({
    graderProviderId: canaryDraft.graderProviderId.trim(),
    graderModelName: canaryDraft.graderModel.trim(),
    graderModelRevision: canaryDraft.graderModelRevision.trim(),
    policy: DEFAULT_ONLINE_GRADER_POLICY,
    reason: t('evolution.onlineGraderPolicyReason'),
  })

  const configureCanaryGuardrails = async (canary, {
    configureRollback = !canary.rollbackPolicyConfigured,
    configureGrader = !canary.onlineGraderPolicyConfigured,
  } = {}) => {
    if (configureRollback) await createEvolutionCanaryRollbackPolicyApi(canary.id, {
      policy: DEFAULT_ROLLBACK_POLICY,
      reason: t('evolution.rollbackPolicyReason'),
    })
    if (configureGrader) await createEvolutionCanaryGraderPolicyApi(canary.id, graderPolicyInput())
  }

  const createCanary = async () => {
    const sessionIds = canaryDraft.sessionIds.split(',').map((item) => item.trim()).filter(Boolean)
    const trafficPercent = Number(canaryDraft.trafficPercent)
    if (!canaryDraft.approvalId || sessionIds.length === 0
      || !canaryDraft.graderProviderId.trim()
      || !canaryDraft.graderModel.trim()
      || !canaryDraft.graderModelRevision.trim()) {
      setMessage(t('evolution.canaryScopeRequired'))
      return
    }
    setBusy('create-canary')
    try {
      const created = await createEvolutionCanaryApi({
        approvalId: canaryDraft.approvalId,
        sessionIds,
        trafficPercent,
        reason: t('evolution.canaryCreateReason'),
      })
      await configureCanaryGuardrails(created.canary, { configureRollback: true, configureGrader: true })
      setCanaryDraft((current) => ({ ...current, sessionIds: '' }))
      await refresh()
      setMessage(t('evolution.canaryCreated'))
    } catch (error) {
      try { setSnapshot(await loadEvolutionSnapshot()) } catch { /* preserve the actionable create error */ }
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const resumeCanaryGuardrails = async (canary) => {
    if (!canaryDraft.graderProviderId.trim()
      || !canaryDraft.graderModel.trim()
      || !canaryDraft.graderModelRevision.trim()) {
      setMessage(t('evolution.canaryScopeRequired'))
      return
    }
    setBusy(`configure-guardrails:${canary.id}`)
    try {
      await configureCanaryGuardrails(canary)
      await refresh()
      setMessage(t('evolution.canaryCreated'))
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const loadOnlineEvidence = async (canary) => {
    setBusy(`online-evidence:${canary.id}`)
    try {
      const result = await getEvolutionCanaryOnlineGradesApi(canary.id, { limit: 100 })
      setOnlineGradeStates((current) => ({ ...current, [canary.id]: result.state }))
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const gradeOnlineOutcome = async (canary, outcomeId) => {
    setBusy(`online-grade:${outcomeId}`)
    try {
      await runEvolutionCanaryOnlineGradeApi(canary.id, outcomeId)
      const result = await getEvolutionCanaryOnlineGradesApi(canary.id, { limit: 100 })
      setOnlineGradeStates((current) => ({ ...current, [canary.id]: result.state }))
      setMessage(t('evolution.onlineGradeRecorded'))
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const changeCanaryState = async (canary, action) => {
    setBusy(`${action}:${canary.id}`)
    try {
      if (action === 'start') await startEvolutionCanaryApi(canary.id, t('evolution.canaryStartReason'))
      else await stopEvolutionCanaryApi(canary.id, t('evolution.canaryStopReason'))
      setMessage(t(action === 'start' ? 'evolution.canaryStarted' : 'evolution.canaryStopped'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  return {
    approved,
    canaryDraft,
    changeCanaryState,
    createCanary,
    gradeOnlineOutcome,
    loadOnlineEvidence,
    onlineGradeStates,
    resumeCanaryGuardrails,
    setCanaryDraft,
  }
}
