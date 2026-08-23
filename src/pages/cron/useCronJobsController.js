import { useCallback, useEffect, useMemo, useState } from 'react'
import { listAgentsApi } from '../../lib/agentClient.js'
import { createCronJobApi, deleteCronJobApi, listCronJobsApi, runCronJobNowApi, updateCronJobApi } from '../../lib/cronClient.js'
import { listPluginsApi } from '../../lib/pluginClient.js'

export const DEFAULT_CRON_FORM = {
  agentId: '', title: '', kind: 'cron', scheduleType: 'every', scheduleValue: '3600000', execType: 'direct_notify',
  prompt: '', notifyTitle: '', notifyBody: '', pluginId: '', actionId: '', pluginParams: '{}', grantsJson: '[]',
}

export function parseCronGrantsJson(value, t = (key) => key) {
  let grants
  try {
    grants = JSON.parse(String(value || '').trim() || '[]')
  } catch (error) {
    throw new Error(t('cron.invalidGrants'), { cause: error })
  }
  if (!Array.isArray(grants)) throw new Error(t('cron.invalidGrants'))
  return grants
}

export default function useCronJobsController(t) {
  const [jobs, setJobs] = useState([])
  const [activeCount, setActiveCount] = useState(0)
  const [agents, setAgents] = useState([])
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [errAction, setErrAction] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(DEFAULT_CRON_FORM)
  const agentName = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents])
  const reload = useCallback(async () => {
    setErr('')
    setErrAction('')
    setLoading(true)
    try {
      const [jobData, agentData, pluginData] = await Promise.all([listCronJobsApi(), listAgentsApi(), listPluginsApi()])
      setJobs(jobData.jobs || [])
      setActiveCount(jobData.activeCount || 0)
      setAgents(agentData.agents || [])
      setPlugins(pluginData.plugins || [])
    } catch (error) { setErr(error.message || t('errors.loadFailed')) }
    finally { setLoading(false) }
  }, [t])
  useEffect(() => { const timer = window.setTimeout(reload, 0); return () => window.clearTimeout(timer) }, [reload])
  const updateForm = (patch) => setForm((current) => {
    const next = { ...current, ...patch }
    if (patch.kind === 'heartbeat') {
      next.scheduleType = 'every'
      if (Number(next.scheduleValue) < 300000) next.scheduleValue = '300000'
      if (!next.execType) next.execType = 'agent_session'
    }
    return next
  })
  const buildPayload = () => {
    if (form.execType === 'agent_session') return { prompt: form.prompt, agentId: form.agentId || null }
    if (form.execType === 'direct_notify') return { title: form.notifyTitle || form.title, body: form.notifyBody }
    try { return { pluginId: form.pluginId, actionId: form.actionId, params: form.pluginParams.trim() ? JSON.parse(form.pluginParams) : {} } }
    catch (error) { throw new Error(t('cron.invalidPluginParams'), { cause: error }) }
  }
  const create = async (event) => {
    event.preventDefault()
    setSaving(true)
    setErr('')
    setErrAction('')
    try {
      await createCronJobApi({
        agentId: form.agentId || null, title: form.title, kind: form.kind,
        scheduleType: form.kind === 'heartbeat' ? 'every' : form.scheduleType, scheduleValue: form.scheduleValue,
        execType: form.execType, execPayload: buildPayload(), grants: parseCronGrantsJson(form.grantsJson, t), enabled: true,
      })
      setShowCreate(false)
      setForm(DEFAULT_CRON_FORM)
      await reload()
    } catch (error) { setErr(error.message || t('errors.saveFailed')); setErrAction(error.action || '') }
    finally { setSaving(false) }
  }
  const toggleEnabled = async (job) => {
    try { const data = await updateCronJobApi(job.id, { enabled: !job.enabled }); setJobs((current) => current.map((item) => item.id === job.id ? data.job : item)); setActiveCount(data.activeCount || 0) }
    catch (error) { setErr(error.message || t('errors.saveFailed')) }
  }
  const runNow = async (job) => {
    setErr(''); setErrAction('')
    try { const data = await runCronJobNowApi(job.id); setJobs((current) => current.map((item) => item.id === job.id ? data.job : item)); setActiveCount(data.activeCount || 0) }
    catch (error) { setErr(error.message || t('cron.runFailed')); setErrAction(error.action || '') }
  }
  const remove = async (job) => {
    if (!window.confirm(t('cron.confirmDelete', { title: job.title }))) return
    try { const data = await deleteCronJobApi(job.id); setJobs((current) => current.filter((item) => item.id !== job.id)); setActiveCount(data.activeCount || 0) }
    catch (error) { setErr(error.message || t('errors.deleteFailed')) }
  }
  return { activeCount, agentName, agents, create, err, errAction, form, jobs, loading, openCreate: () => { setForm(DEFAULT_CRON_FORM); setShowCreate(true) }, plugins, reload, remove, runNow, saving, setShowCreate, showCreate, toggleEnabled, updateForm }
}
