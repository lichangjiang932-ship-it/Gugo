import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, Play, X, Webhook, Terminal } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { getAuthToken } from '../lib/accountClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

const EVENTS = [
  { id: 'user_prompt_submit', labelKey: 'hooks.eventUserPrompt' },
  { id: 'pre_tool_use', labelKey: 'hooks.eventPreTool' },
  { id: 'post_tool_use', labelKey: 'hooks.eventPostTool' },
  { id: 'stop', labelKey: 'hooks.eventStop' },
]

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function jsonFetch(url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  })
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${resp.status}`)
  }
  return data
}

function emptyHook() {
  return {
    id: '',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'https://',
    headers: {},
    command: [],
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  }
}

export default function HooksView() {
  const { t } = useT()
  const [hooks, setHooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await jsonFetch('/api/hooks')
      setHooks(data.hooks || [])
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setErr('')
    try {
      const payload = { ...editing }
      if (payload.kind === 'shell' && typeof payload.command === 'string') {
        // 把空格分隔的命令字符串改成 argv 数组（简单版本）
        payload.command = payload.command.trim().split(/\s+/)
      }
      await jsonFetch('/api/hooks', { method: 'POST', body: JSON.stringify(payload) })
      setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id) => {
    if (!window.confirm(t('hooks.confirmDelete'))) return
    try {
      await jsonFetch(`/api/hooks/${id}`, { method: 'DELETE' })
      if (editing?.id === id) setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message)
    }
  }

  const test = async (id) => {
    setTestResult(null)
    try {
      const data = await jsonFetch(`/api/hooks/${id}/test`, { method: 'POST' })
      setTestResult(data.result)
    } catch (e) {
      setTestResult({ error: e.message })
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
          <Webhook className="w-5 h-5 text-ember" />
          <div className="flex-1">
            <div className="text-base font-semibold text-ink">Hooks</div>
            <div className="text-[11px] text-ink-fade">{t('hooks.subtitle')}</div>
          </div>
          <button
            type="button"
            onClick={() => setEditing(emptyHook())}
            className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('hooks.add')}
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-[420px] border-r border-ink/10 overflow-auto">
            {loading && <div className="p-4 text-sm text-ink-fade">{t('hooks.loading')}</div>}
            {err && <div className="p-4 text-sm text-rose-700">{err}</div>}
            {!loading && hooks.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-fade">{t('hooks.empty')}</div>
            )}
            {hooks.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setEditing(h)}
                className={`w-full text-left border-b border-ink/5 px-4 py-3 hover:bg-paper-2 ${
                  editing?.id === h.id ? 'bg-ember/10' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  {h.kind === 'shell'
                    ? <Terminal className="w-3.5 h-3.5 text-ink-fade" />
                    : <Webhook className="w-3.5 h-3.5 text-ink-fade" />}
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ember">{h.event}</span>
                  {!h.enabled && <span className="text-[10px] text-ink-fade">{t('hooks.disabled')}</span>}
                  {h.blocking && <span className="text-[10px] text-amber-700">{t('hooks.blocking')}</span>}
                </div>
                <div className="text-xs text-ink truncate mt-1">
                  {h.kind === 'http' ? h.url : (Array.isArray(h.command) ? h.command.join(' ') : '')}
                </div>
                <div className="text-[10px] text-ink-fade mt-0.5">
                  {t('hooks.matchTimeout', { pattern: h.toolPattern || '*', timeout: h.timeoutMs })}
                </div>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto">
            {!editing ? (
              <div className="h-full flex items-center justify-center text-sm text-ink-fade">
                {t('hooks.choose')}
              </div>
            ) : (
              <div className="max-w-[720px] mx-auto px-8 py-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink">{editing.id ? t('hooks.edit') : t('hooks.create')}</div>
                  <button type="button" onClick={() => setEditing(null)} className="text-ink-fade hover:text-ink"><X className="w-4 h-4" /></button>
                </div>

                <Field label={t('hooks.event')}>
                  <select
                    value={editing.event}
                    onChange={(e) => setEditing({ ...editing, event: e.target.value })}
                    className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none"
                  >
                    {EVENTS.map((e) => <option key={e.id} value={e.id}>{t(e.labelKey)}</option>)}
                  </select>
                </Field>

                <Field label={t('hooks.toolPattern')}>
                  <input
                    value={editing.toolPattern}
                    onChange={(e) => setEditing({ ...editing, toolPattern: e.target.value })}
                    className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
                  />
                </Field>

                <Field label={t('hooks.kind')}>
                  <div className="flex gap-1.5">
                    <KindChip active={editing.kind === 'http'} onClick={() => setEditing({ ...editing, kind: 'http' })}>{t('hooks.httpCallback')}</KindChip>
                    <KindChip active={editing.kind === 'shell'} onClick={() => setEditing({ ...editing, kind: 'shell' })}>{t('hooks.shellEnabled')}</KindChip>
                  </div>
                </Field>

                {editing.kind === 'http' ? (
                  <Field label="HTTPS URL (POST JSON)">
                    <input
                      value={editing.url || ''}
                      onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                      placeholder="https://your-host/hook"
                      className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
                    />
                  </Field>
                ) : (
                  <Field label={t('hooks.shellArgv')}>
                    <input
                      value={Array.isArray(editing.command) ? editing.command.join(' ') : editing.command || ''}
                      onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                      placeholder="node hooks/audit.js"
                      className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono"
                    />
                  </Field>
                )}

                <div className="flex items-center gap-4 text-xs text-ink-soft">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                    {t('hooks.enabled')}
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={editing.blocking} onChange={(e) => setEditing({ ...editing, blocking: e.target.checked })} />
                    {t('hooks.blockingMode')}
                  </label>
                  <label className="flex items-center gap-2">
                    {t('hooks.timeout')}
                    <input
                      type="number"
                      value={editing.timeoutMs}
                      onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) || 5000 })}
                      className="w-20 h-7 px-2 text-xs bg-paper-2 border border-ink/15 rounded-md"
                    />
                  </label>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="h-8 px-4 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />{saving ? t('hooks.saving') : t('hooks.save')}
                  </button>
                  {editing.id && (
                    <>
                      <button type="button" onClick={() => test(editing.id)} className="h-8 px-3 border border-ink/15 text-ink-soft rounded-md text-xs hover:bg-paper-2 flex items-center gap-1">
                        <Play className="w-3.5 h-3.5" />{t('hooks.test')}
                      </button>
                      <button type="button" onClick={() => remove(editing.id)} className="h-8 px-3 border border-rose-300 text-rose-700 rounded-md text-xs hover:bg-rose-50 flex items-center gap-1">
                        <Trash2 className="w-3.5 h-3.5" />{t('hooks.delete')}
                      </button>
                    </>
                  )}
                </div>

                {testResult && (
                  <div className="mt-2 p-3 bg-paper-2 border border-ink/10 rounded-md text-xs font-mono whitespace-pre-wrap break-all">
                    {JSON.stringify(testResult, null, 2)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-[11px] text-ink-fade mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function KindChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 text-xs rounded-md border transition-colors ${
        active ? 'bg-ember text-paper border-ember' : 'bg-paper-2 border-ink/15 text-ink-soft hover:border-ember/50'
      }`}
    >
      {children}
    </button>
  )
}
