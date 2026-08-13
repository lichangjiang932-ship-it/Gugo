import { useCallback, useEffect, useState } from 'react'
import { Plus, Webhook } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import HookEditor from './hooks/HookEditor.jsx'
import HooksList from './hooks/HooksList.jsx'
import { createEmptyHook, requestHooks } from './hooks/hooksClient.js'

export default function HooksView() {
  const { t } = useT()
  const [hooks, setHooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setHooks((await requestHooks('/api/hooks')).hooks || []) } catch (caught) { setError(caught.message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { const timer = window.setTimeout(reload, 0); return () => window.clearTimeout(timer) }, [reload])
  const save = async () => {
    if (!editing) return
    setSaving(true); setError('')
    try {
      const payload = { ...editing }
      if (payload.kind === 'shell' && typeof payload.command === 'string') payload.command = payload.command.trim().split(/\s+/)
      const matcherText = String(payload.argumentMatcherText || '').trim()
      if (matcherText) {
        try {
          payload.argumentMatcher = JSON.parse(matcherText)
        } catch {
          throw new Error(t('hooks.argumentMatcherInvalid'))
        }
      } else {
        payload.argumentMatcher = null
      }
      delete payload.argumentMatcherText
      await requestHooks('/api/hooks', { method: 'POST', body: JSON.stringify(payload) })
      setEditing(null); await reload()
    } catch (caught) { setError(caught.message) } finally { setSaving(false) }
  }
  const remove = async (id) => {
    if (!window.confirm(t('hooks.confirmDelete'))) return
    try { await requestHooks(`/api/hooks/${id}`, { method: 'DELETE' }); if (editing?.id === id) setEditing(null); await reload() } catch (caught) { setError(caught.message) }
  }
  const test = async (id) => {
    setTestResult(null)
    try { setTestResult((await requestHooks(`/api/hooks/${id}/test`, { method: 'POST' })).result) } catch (caught) { setTestResult({ error: caught.message }) }
  }
  return <div className="flex h-screen overflow-hidden bg-paper"><LeftRail /><div className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center gap-3 border-b border-ink/10 px-6 py-4"><Webhook className="h-5 w-5 text-ember" /><div className="flex-1"><div className="text-base font-semibold text-ink">Hooks</div><div className="text-[11px] text-ink-fade">{t('hooks.subtitle')}</div></div><button type="button" onClick={() => setEditing(createEmptyHook())} className="flex h-8 items-center gap-1 rounded-md bg-ember px-3 text-xs text-paper hover:bg-ember/90"><Plus className="h-3.5 w-3.5" />{t('hooks.add')}</button></div>
    <div className="flex min-h-0 flex-1"><HooksList editingId={editing?.id} error={error} hooks={hooks} loading={loading} onEdit={(hook) => setEditing({ ...hook, argumentMatcherText: hook.argumentMatcher ? JSON.stringify(hook.argumentMatcher, null, 2) : '' })} t={t} /><div className="flex-1 overflow-auto"><HookEditor editing={editing} onChange={setEditing} onClose={() => setEditing(null)} onDelete={remove} onSave={save} onTest={test} saving={saving} testResult={testResult} t={t} /></div></div>
  </div></div>
}
