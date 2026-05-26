import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import { listAgentsApi } from '../lib/agentClient.js'
import { listPluginsApi } from '../lib/pluginClient.js'
import {
  createCronJobApi,
  deleteCronJobApi,
  listCronJobsApi,
  runCronJobNowApi,
  updateCronJobApi,
} from '../lib/cronClient.js'

const DEFAULT_FORM = {
  agentId: '',
  title: '',
  kind: 'cron',
  scheduleType: 'every',
  scheduleValue: '3600000',
  execType: 'direct_notify',
  prompt: '',
  notifyTitle: '',
  notifyBody: '',
  pluginId: '',
  actionId: '',
  pluginParams: '{}',
}

function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function compactPayload(job) {
  const payload = job.execPayload || {}
  if (job.execType === 'agent_session') return payload.prompt || ''
  if (job.execType === 'direct_notify') return [payload.title, payload.body].filter(Boolean).join(' / ')
  if (job.execType === 'plugin_action') return [payload.pluginId, payload.actionId].filter(Boolean).join(' / ')
  return ''
}

export default function CronJobsPage() {
  const { t } = useT()
  const [jobs, setJobs] = useState([])
  const [activeCount, setActiveCount] = useState(0)
  const [agents, setAgents] = useState([])
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(DEFAULT_FORM)

  const agentName = useMemo(() => {
    const map = new Map()
    for (const agent of agents) map.set(agent.id, agent.name)
    return map
  }, [agents])

  const reload = async () => {
    setErr('')
    setLoading(true)
    try {
      const [jobData, agentData, pluginData] = await Promise.all([
        listCronJobsApi(),
        listAgentsApi(),
        listPluginsApi(),
      ])
      setJobs(jobData.jobs || [])
      setActiveCount(jobData.activeCount || 0)
      setAgents(agentData.agents || [])
      setPlugins(pluginData.plugins || [])
    } catch (error) {
      setErr(error.message || t('errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateForm = (patch) => {
    setForm((current) => {
      const next = { ...current, ...patch }
      if (patch.kind === 'heartbeat') {
        next.scheduleType = 'every'
        if (Number(next.scheduleValue) < 300000) next.scheduleValue = '300000'
        if (!next.execType) next.execType = 'agent_session'
      }
      return next
    })
  }

  const buildPayload = () => {
    if (form.execType === 'agent_session') {
      return { prompt: form.prompt, agentId: form.agentId || null }
    }
    if (form.execType === 'direct_notify') {
      return { title: form.notifyTitle || form.title, body: form.notifyBody }
    }
    let params
    try {
      params = form.pluginParams.trim() ? JSON.parse(form.pluginParams) : {}
    } catch {
      throw new Error(t('cron.invalidPluginParams'))
    }
    return { pluginId: form.pluginId, actionId: form.actionId, params }
  }

  const handleCreate = async (event) => {
    event.preventDefault()
    setSaving(true)
    setErr('')
    try {
      const payload = buildPayload()
      await createCronJobApi({
        agentId: form.agentId || null,
        title: form.title,
        kind: form.kind,
        scheduleType: form.kind === 'heartbeat' ? 'every' : form.scheduleType,
        scheduleValue: form.scheduleValue,
        execType: form.execType,
        execPayload: payload,
        enabled: true,
      })
      setShowCreate(false)
      setForm(DEFAULT_FORM)
      await reload()
    } catch (error) {
      setErr(error.message || t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (job) => {
    try {
      const data = await updateCronJobApi(job.id, { enabled: !job.enabled })
      setJobs((current) => current.map((item) => (item.id === job.id ? data.job : item)))
      setActiveCount(data.activeCount || 0)
    } catch (error) {
      setErr(error.message || t('errors.saveFailed'))
    }
  }

  const runNow = async (job) => {
    try {
      const data = await runCronJobNowApi(job.id)
      setJobs((current) => current.map((item) => (item.id === job.id ? data.job : item)))
      setActiveCount(data.activeCount || 0)
    } catch (error) {
      setErr(error.message || t('cron.runFailed'))
    }
  }

  const removeJob = async (job) => {
    if (!window.confirm(t('cron.confirmDelete', { title: job.title }))) return
    try {
      const data = await deleteCronJobApi(job.id)
      setJobs((current) => current.filter((item) => item.id !== job.id))
      setActiveCount(data.activeCount || 0)
    } catch (error) {
      setErr(error.message || t('errors.deleteFailed'))
    }
  }

  return (
    <div className="h-screen flex bg-paper text-ink overflow-hidden">
      <LeftRail />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-5">
          <header className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <CalendarClock className="w-5 h-5 text-ember" />
                <h1 className="font-display text-2xl text-ink">{t('cron.title')}</h1>
                <span className="inline-flex items-center h-6 px-2 rounded-md border border-ink-fade/40 bg-paper-2 text-xs text-ink-soft">
                  {t('cron.activeBadge', { count: activeCount })}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-fade">{t('cron.subtitle')}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={reload}
                className="h-9 px-3 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2 inline-flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                {t('settings.refresh')}
              </button>
              <button
                type="button"
                onClick={() => { setForm(DEFAULT_FORM); setShowCreate(true) }}
                className="h-9 px-3 rounded-md bg-ember text-paper text-sm hover:bg-ember/90 inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                {t('cron.new')}
              </button>
            </div>
          </header>

          {err && (
            <div className="border border-red-300 bg-red-50 text-red-700 px-3 py-2 rounded-md text-sm">
              {err}
            </div>
          )}

          <section className="border border-ink-fade/30 rounded-md overflow-hidden">
            <div className="grid grid-cols-[1.3fr_0.8fr_1fr_0.9fr_0.9fr_0.9fr_1.1fr] gap-3 px-4 py-2 bg-paper-2 text-[11px] font-mono uppercase tracking-wider text-ink-fade">
              <span>{t('cron.job')}</span>
              <span>{t('cron.kind')}</span>
              <span>{t('cron.schedule')}</span>
              <span>{t('cron.lastRun')}</span>
              <span>{t('cron.status')}</span>
              <span>{t('cron.nextRun')}</span>
              <span className="text-right">{t('cron.actions')}</span>
            </div>
            {loading ? (
              <div className="p-8 text-sm text-ink-fade">{t('common.loading')}</div>
            ) : jobs.length ? (
              <div className="divide-y divide-ink-fade/20">
                {jobs.map((job) => (
                  <div key={job.id} className="grid grid-cols-[1.3fr_0.8fr_1fr_0.9fr_0.9fr_0.9fr_1.1fr] gap-3 px-4 py-3 items-center text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => toggleEnabled(job)}
                          className={`w-8 h-4 rounded-full border transition-colors ${job.enabled ? 'bg-ember border-ember' : 'bg-paper border-ink-fade/50'}`}
                          aria-label={job.enabled ? t('cron.disable') : t('cron.enable')}
                        >
                          <span className={`block w-3 h-3 rounded-full bg-paper transition-transform ${job.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                        <span className="truncate font-medium text-ink">{job.title}</span>
                      </div>
                      <div className="mt-1 text-xs text-ink-fade truncate">
                        {job.agentId ? agentName.get(job.agentId) || job.agentId : t('cron.allAgents')}
                        {compactPayload(job) ? ` · ${compactPayload(job)}` : ''}
                      </div>
                    </div>
                    <span className="text-ink-soft">{t(`cron.kind_${job.kind}`)}</span>
                    <span className="font-mono text-xs text-ink-soft truncate">{job.scheduleType}: {job.scheduleValue}</span>
                    <span className="text-xs text-ink-fade">{formatTime(job.lastRunAt)}</span>
                    <span className={`text-xs ${job.lastStatus === 'error' ? 'text-red-600' : 'text-ink-soft'}`}>
                      {job.lastStatus || '-'}
                    </span>
                    <span className="text-xs text-ink-fade">{formatTime(job.nextRunAt)}</span>
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => runNow(job)}
                        title={t('cron.runNow')}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-ink-fade/30 text-ink-soft hover:bg-paper-2"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeJob(job)}
                        title={t('common.delete')}
                        className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-ink-fade/30 text-ink-soft hover:bg-paper-2"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-sm text-ink-fade">{t('cron.empty')}</div>
            )}
          </section>
        </div>
      </main>

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-ink/35 flex items-center justify-center p-4">
          <form onSubmit={handleCreate} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-paper border border-ink rounded-md p-5 shadow-xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl text-ink">{t('cron.newTitle')}</h2>
              <button type="button" onClick={() => setShowCreate(false)} className="text-ink-fade hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{t('cron.fieldTitle')}</span>
                <input
                  value={form.title}
                  onChange={(e) => updateForm({ title: e.target.value })}
                  required
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{t('cron.fieldAgent')}</span>
                <select
                  value={form.agentId}
                  onChange={(e) => updateForm({ agentId: e.target.value })}
                  required={form.kind === 'heartbeat'}
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                >
                  <option value="">{t('cron.allAgents')}</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{t('cron.kind')}</span>
                <select
                  value={form.kind}
                  onChange={(e) => updateForm({ kind: e.target.value })}
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                >
                  <option value="cron">{t('cron.kind_cron')}</option>
                  <option value="heartbeat">{t('cron.kind_heartbeat')}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{t('cron.scheduleType')}</span>
                <select
                  value={form.scheduleType}
                  onChange={(e) => updateForm({ scheduleType: e.target.value })}
                  disabled={form.kind === 'heartbeat'}
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm disabled:opacity-60"
                >
                  <option value="at">at</option>
                  <option value="every">every</option>
                  <option value="cron">cron</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{t('cron.scheduleValue')}</span>
                <input
                  value={form.scheduleValue}
                  onChange={(e) => updateForm({ scheduleValue: e.target.value })}
                  required
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-fade">{t('cron.execType')}</span>
              <select
                value={form.execType}
                onChange={(e) => updateForm({ execType: e.target.value })}
                className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
              >
                <option value="agent_session">agent_session</option>
                <option value="direct_notify">direct_notify</option>
                <option value="plugin_action">plugin_action</option>
              </select>
            </label>

            {form.execType === 'agent_session' && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{t('cron.prompt')}</span>
                <textarea
                  value={form.prompt}
                  onChange={(e) => updateForm({ prompt: e.target.value })}
                  required
                  rows={5}
                  className="px-3 py-2 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm resize-y"
                />
              </label>
            )}

            {form.execType === 'direct_notify' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">{t('cron.notifyTitle')}</span>
                  <input
                    value={form.notifyTitle}
                    onChange={(e) => updateForm({ notifyTitle: e.target.value })}
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">{t('cron.notifyBody')}</span>
                  <input
                    value={form.notifyBody}
                    onChange={(e) => updateForm({ notifyBody: e.target.value })}
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                  />
                </label>
              </div>
            )}

            {form.execType === 'plugin_action' && (
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">{t('cron.plugin')}</span>
                  <select
                    value={form.pluginId}
                    onChange={(e) => updateForm({ pluginId: e.target.value })}
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                  >
                    <option value="">{t('cron.pluginNone')}</option>
                    {plugins.map((plugin) => (
                      <option key={plugin.id} value={plugin.id}>{plugin.name || plugin.id}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">{t('cron.action')}</span>
                  <input
                    value={form.actionId}
                    onChange={(e) => updateForm({ actionId: e.target.value })}
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm"
                  />
                </label>
                <label className="col-span-2 flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">{t('cron.params')}</span>
                  <textarea
                    value={form.pluginParams}
                    onChange={(e) => updateForm({ pluginParams: e.target.value })}
                    rows={4}
                    className="px-3 py-2 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm font-mono resize-y"
                  />
                </label>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="h-9 px-4 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="h-9 px-4 rounded-md bg-ink text-paper text-sm hover:bg-ink-soft disabled:opacity-60"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
