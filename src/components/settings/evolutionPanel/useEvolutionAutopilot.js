import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getEvolutionAutoConfigApi,
  listEvolutionAutoRunsApi,
  saveEvolutionAutoConfigApi,
} from '../../../lib/evolutionClient.js'
import { actionMessage } from './evolutionUtils.js'

const DEFAULT_OBJECTIVE = 'Improve workspace reliability, task completion, and explicit capability-gap reporting from verified local evidence.'

function modelName(value) {
  if (typeof value === 'string') return value.trim()
  return String(value?.name || value?.id || '').trim()
}

export function evolutionModelIdentities(providers = []) {
  return providers.flatMap((provider) => (provider.models || []).map((model) => ({
    providerId: String(provider.id || '').trim(),
    modelName: modelName(model),
  }))).filter((item) => item.providerId && item.modelName)
}

export function resolveAutopilotModels(providers = [], config = null) {
  if (config?.generator?.providerId && config?.generator?.modelName
    && config?.replay?.providerId && config?.replay?.modelName
    && config?.evaluator?.providerId && config?.evaluator?.modelName) {
    return {
      generator: config.generator,
      replay: config.replay,
      evaluator: config.evaluator,
    }
  }
  const identities = evolutionModelIdentities(providers)
  const replay = identities[0] || null
  const evaluator = identities.find((item) => (
    item.providerId !== replay?.providerId || item.modelName !== replay?.modelName
  )) || null
  if (!replay || !evaluator) return null
  return { generator: replay, replay, evaluator }
}

export function buildAutopilotEnabledPayload(config, models) {
  return {
    enabled: true,
    target: 'prompt:workspace-instructions',
    objective: String(config?.objective || DEFAULT_OBJECTIVE).trim(),
    generator: models.generator,
    replay: models.replay,
    evaluator: models.evaluator,
    minimumSignalCount: config?.minimumSignalCount || 3,
    maximumSourceRecords: config?.maximumSourceRecords || 10,
    cooldownMs: config?.cooldownMs || 86_400_000,
    trafficPercent: config?.trafficPercent || 10,
    canaryMaxOutcomes: config?.canaryMaxOutcomes || 20,
    canaryMaxAgeMs: config?.canaryMaxAgeMs || 86_400_000,
    ...(config?.rollbackPolicy ? { rollbackPolicy: config.rollbackPolicy } : {}),
  }
}

export default function useEvolutionAutopilot({ providers, t }) {
  const [config, setConfig] = useState(null)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const models = useMemo(() => resolveAutopilotModels(providers, config), [config, providers])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [configResult, runsResult] = await Promise.all([
        getEvolutionAutoConfigApi(),
        listEvolutionAutoRunsApi({ limit: 20 }),
      ])
      setConfig(configResult.config || null)
      setRuns(runsResult.runs || [])
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    let active = true
    void Promise.all([
      getEvolutionAutoConfigApi(),
      listEvolutionAutoRunsApi({ limit: 20 }),
    ]).then(([configResult, runsResult]) => {
      if (!active) return
      setConfig(configResult.config || null)
      setRuns(runsResult.runs || [])
      setMessage('')
    }).catch((error) => {
      if (active) setMessage(actionMessage(error, t))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [t])

  const setEnabled = async (enabled) => {
    if (enabled && !models) {
      setMessage(t('evolution.autopilotMissingModels'))
      return
    }
    setBusy(true)
    try {
      const result = await saveEvolutionAutoConfigApi(
        enabled ? buildAutopilotEnabledPayload(config, models) : { enabled: false },
      )
      setConfig(result.config || null)
      setMessage(t(enabled ? 'evolution.autopilotEnabled' : 'evolution.autopilotStopped'))
      const runsResult = await listEvolutionAutoRunsApi({ limit: 20 })
      setRuns(runsResult.runs || [])
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    config,
    latestRun: runs[0] || null,
    loading,
    message,
    models,
    refresh,
    runs,
    setEnabled,
  }
}
