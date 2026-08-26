import { ArrowDown, ArrowUp, Check, ExternalLink, KeyRound, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WEB_SEARCH_PROVIDERS } from '../../../shared/webSearchProviders.js'
import {
  deleteWebSearchConfigApi,
  getWebSearchConfigApi,
  saveWebSearchConfigApi,
  testWebSearchApi,
} from '../../lib/webSearchClient.js'

const CUSTOM_DEFAULTS = Object.freeze({
  baseUrl: '', method: 'POST', queryParam: 'q', headersTemplate: '{\n  "Authorization": "Bearer {apiKey}"\n}',
  bodyTemplate: '{\n  "q": "{query}",\n  "num": "{maxResults}"\n}', resultPath: 'results',
  titlePath: 'title', urlPath: 'url', snippetPath: 'snippet',
})

let connectionSequence = 0

function createConnection(overrides = {}) {
  connectionSequence += 1
  return {
    id: overrides.id || `search-${Date.now().toString(36)}-${connectionSequence}`,
    provider: overrides.provider || 'tavily',
    enabled: overrides.enabled !== false,
    config: overrides.config || {},
    apiKey: '',
    apiKeyPresent: Boolean(overrides.apiKeyPresent),
  }
}

function hydrateConnections(config) {
  if (Array.isArray(config?.connections) && config.connections.length) {
    return config.connections.map((item) => createConnection(item))
  }
  if (config?.provider) {
    return [createConnection({
      id: 'primary',
      provider: config.provider,
      enabled: true,
      config: config.config,
      apiKeyPresent: config.apiKeyPresent,
    })]
  }
  return [createConnection()]
}

function Field({ label, value, onChange, placeholder = '', multiline = false, type = 'text' }) {
  const className = 'min-w-0 w-full rounded-lg border border-ink/15 bg-paper px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-fade hover:border-ink/25 focus:border-focus focus:ring-2 focus:ring-focus/15'
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs text-ink-soft"><span>{label}</span>{multiline
    ? <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={`${className} resize-y font-mono text-xs`} />
    : <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={className} />}</label>
}

function Toggle({ enabled, onChange, label }) {
  return <button type="button" role="switch" aria-checked={enabled} aria-label={label} onClick={() => onChange(!enabled)} className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/25 ${enabled ? 'border-success bg-success' : 'border-ink/15 bg-paper-2'}`}><span className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-paper shadow-sm transition-all ${enabled ? 'left-[21px]' : 'left-0.5'}`} /></button>
}

function BrandMark({ item, size = 'md' }) {
  const cls = size === 'lg' ? 'h-7 w-7 rounded-md text-xs' : 'h-5 w-5 rounded text-[9px]'
  return <span className={`grid shrink-0 place-items-center font-semibold ${cls} ${item?.accent || 'bg-ink-fade/15 text-ink-soft'}`}>{item?.initial || '·'}</span>
}

export default function SettingsWebSearchPanel({ t }) {
  const [connections, setConnections] = useState(() => [createConnection()])
  const [selectedId, setSelectedId] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [lastTest, setLastTest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [message, setMessage] = useState('')

  const selectedIndex = Math.max(0, connections.findIndex((item) => item.id === selectedId))
  const selected = connections[selectedIndex] || connections[0]
  const meta = WEB_SEARCH_PROVIDERS.find((item) => item.id === selected?.provider) || WEB_SEARCH_PROVIDERS[0]

  const replaceConnection = (id, updater) => {
    setConnections((current) => current.map((item) => (item.id === id ? updater(item) : item)))
  }
  const updateConfig = (key, value) => replaceConnection(selected.id, (item) => ({
    ...item,
    config: { ...item.config, [key]: value },
  }))

  useEffect(() => {
    let active = true
    getWebSearchConfigApi().then((data) => {
      if (!active) return
      const next = hydrateConnections(data.config)
      setConnections(next)
      setSelectedId(next[0].id)
      setEnabled(data.config?.enabled !== false)
      setLastTest(data.config?.lastTest || null)
    }).catch((error) => { if (active) setMessage(error.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const payload = () => ({
    enabled,
    strategy: 'fallback',
    connections: connections.map((item) => ({
      id: item.id,
      provider: item.provider,
      enabled: item.enabled,
      config: item.provider === 'custom' ? { ...CUSTOM_DEFAULTS, ...item.config } : item.config,
      ...(item.apiKey ? { apiKey: item.apiKey } : {}),
    })),
  })

  const save = async ({ test = false } = {}) => {
    setWorking(test ? 'test' : 'save'); setMessage('')
    try {
      const saved = await saveWebSearchConfigApi(payload())
      const next = hydrateConnections(saved.config)
      setConnections(next)
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0].id)
      setLastTest(saved.config?.lastTest || null)
      if (test) {
        const tested = await testWebSearchApi({ connectionId: selected.id })
        setLastTest({ at: Date.now(), ok: true, message: tested.result?.message || '' })
        setMessage(t('webSearch.testSuccess', { count: tested.result?.resultCount ?? 0 }))
      } else setMessage(t('webSearch.saved'))
    } catch (error) {
      setMessage(t('webSearch.failed', { message: error.message }))
      if (test) setLastTest({ at: Date.now(), ok: false, message: error.message })
    } finally { setWorking('') }
  }

  const clear = async () => {
    if (!window.confirm(t('webSearch.clearConfirm'))) return
    setWorking('clear'); setMessage('')
    try {
      await deleteWebSearchConfigApi()
      const next = createConnection()
      setConnections([next]); setSelectedId(next.id); setEnabled(true); setLastTest(null)
      setMessage(t('webSearch.cleared'))
    } catch (error) { setMessage(t('webSearch.failed', { message: error.message })) }
    finally { setWorking('') }
  }

  const addConnection = () => {
    const next = createConnection()
    setConnections((current) => [...current, next])
    setSelectedId(next.id)
    setMessage('')
  }

  const removeConnection = (id) => {
    if (connections.length <= 1) return
    const index = connections.findIndex((item) => item.id === id)
    const next = connections.filter((item) => item.id !== id)
    setConnections(next)
    if (id === selectedId) setSelectedId(next[Math.min(index, next.length - 1)].id)
    setMessage('')
  }

  const moveConnection = (id, offset) => {
    setConnections((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + offset
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  if (loading) return <div className="text-sm text-ink-fade">{t('common.loading')}</div>

  return <section className="web-search-settings flex min-w-0 max-w-full flex-col gap-5 text-ink">
    <div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">WEB SEARCH</span><h1 className="mt-1 text-[22px] font-semibold leading-tight text-ink">{t('webSearch.title')}</h1><p className="mt-1 text-sm text-ink-soft">{t('webSearch.subtitle')}</p></div>
    <div className="flex min-h-[60px] min-w-0 items-center gap-3 rounded-xl bg-success/10 px-4 py-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-success/15"><ShieldCheck className="h-4 w-4 text-success" /></span><p className="min-w-0 flex-1 text-xs leading-5 text-ink-soft">{t('webSearch.security')}</p><Toggle enabled={enabled} onChange={setEnabled} label={t('webSearch.enabled')} /></div>
    <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-ink/10 bg-paper p-4 sm:p-[18px]">
      <div className="flex min-w-0 flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start sm:gap-4"><div className="min-w-0"><h2 className="text-base font-medium text-ink">{t('webSearch.provider')}</h2><p className="mt-1 text-xs leading-5 text-ink-soft">{t('webSearch.fallbackHint')}</p></div><button type="button" onClick={addConnection} disabled={connections.length >= 8 || Boolean(working)} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-ink/15 bg-paper px-3.5 text-xs text-ink transition-colors hover:bg-paper-2 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{t('webSearch.addApi')}</button></div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(190px,0.72fr)_minmax(0,1.7fr)]">
        <div className="flex min-w-0 flex-col gap-2.5" data-testid="web-search-connections">
          {connections.map((item, index) => {
            const providerMeta = WEB_SEARCH_PROVIDERS.find((candidate) => candidate.id === item.provider)
            const active = item.id === selected?.id
            return <div key={item.id} className={`min-w-0 rounded-xl border py-3 pr-3 transition-colors ${active ? 'border-ink/10 border-l-4 border-l-focus bg-paper-2 pl-[9px]' : 'border-ink/10 bg-paper pl-3 hover:bg-paper-2/60'}`}>
              <button type="button" onClick={() => { setSelectedId(item.id); setMessage('') }} className="flex w-full items-center gap-2.5 text-left">
                <BrandMark item={providerMeta} />
                <span className="min-w-0 flex-1"><span className={`block truncate text-sm font-medium ${active ? 'text-focus' : 'text-ink'}`}>{providerMeta?.label || item.provider}</span><span className={`mt-1 flex items-center gap-1.5 text-[10px] ${active ? 'text-focus/75' : 'text-ink-fade'}`}><span className={`h-1.5 w-1.5 rounded-full ${item.enabled ? 'bg-success' : 'bg-ink-fade'}`} />{t('webSearch.priority', { index: index + 1 })} · {item.apiKeyPresent ? t('webSearch.keySaved') : t('webSearch.keyMissing')}</span></span>
              </button>
              {connections.length > 1 ? <div className="mt-3 flex items-center gap-1 border-t border-ink/10 pt-2.5" data-testid="web-search-connection-actions">
                <button type="button" disabled={index === 0} onClick={() => moveConnection(item.id, -1)} aria-label={t('webSearch.moveUp')} className="rounded-md p-1.5 text-ink-fade hover:bg-ink/5 disabled:opacity-25"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={index === connections.length - 1} onClick={() => moveConnection(item.id, 1)} aria-label={t('webSearch.moveDown')} className="rounded-md p-1.5 text-ink-fade hover:bg-ink/5 disabled:opacity-25"><ArrowDown className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => removeConnection(item.id)} aria-label={t('webSearch.removeApi')} className="ml-auto rounded p-1 text-danger hover:bg-danger/5"><Trash2 className="h-3.5 w-3.5" /></button>
              </div> : null}
            </div>
          })}
        </div>
        {selected ? <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-ink/10 bg-paper p-4" data-testid="web-search-connection-editor">
          <div className="flex min-w-0 flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center"><div className="flex min-w-0 items-center gap-2.5"><BrandMark item={meta} size="lg" /><div className="min-w-0"><h3 className="truncate text-sm font-medium text-ink">{meta.label}</h3><p className="mt-1 text-[10px] text-ink-fade">{t('webSearch.apiSettings')} · {t('webSearch.priority', { index: selectedIndex + 1 })}</p></div></div><div className="flex items-center justify-between gap-2.5 sm:justify-start"><span className="text-xs text-ink-soft">{t('webSearch.useThisApi')}</span><Toggle enabled={selected.enabled} onChange={(value) => replaceConnection(selected.id, (item) => ({ ...item, enabled: value }))} label={t('webSearch.useThisApi')} /></div></div>
          <div className="grid min-w-0 grid-cols-2 gap-2.5 lg:grid-cols-3" data-testid="web-search-template-grid">{WEB_SEARCH_PROVIDERS.map((item) => { const chosen = selected.provider === item.id; return <button key={item.id} type="button" data-provider={item.id} onClick={() => replaceConnection(selected.id, (current) => item.id === current.provider ? current : { ...current, provider: item.id, config: {}, apiKey: '', apiKeyPresent: false })} className={`relative min-w-0 rounded-xl border bg-paper p-2.5 text-left transition-colors ${chosen ? 'border-focus' : 'border-ink/10 hover:border-ink/20 hover:bg-paper-2'}`}>{chosen && <Check className="absolute right-2 top-2 h-3 w-3 text-focus" />}<span className="flex min-w-0 flex-col gap-1.5"><BrandMark item={item} /><span className="min-w-0 pr-1"><span className="block min-h-8 whitespace-normal break-words text-[12px] leading-4 text-ink">{item.label}</span><span className="mt-0.5 block text-[9px] text-ink-fade">{item.id === 'custom' ? t('webSearch.customBadge') : t('webSearch.presetBadge')}</span></span></span></button> })}</div>
          {meta.docsUrl ? <a href={meta.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-xs text-focus hover:text-focus/80">{t('webSearch.getApiKey')}<ExternalLink className="h-3 w-3" /></a> : null}
          <Field type="password" label={t('webSearch.apiKey')} value={selected.apiKey} onChange={(value) => replaceConnection(selected.id, (item) => ({ ...item, apiKey: value }))} placeholder={selected.apiKeyPresent ? t('webSearch.secretKept') : t('webSearch.apiKeyPlaceholder')} />
          {selected.provider === 'google_cse' ? <Field label={t('webSearch.googleCx')} value={selected.config.cx || ''} onChange={(value) => updateConfig('cx', value)} placeholder="0123456789:abcdef" /> : null}
          {selected.provider === 'custom' ? <div className="grid gap-4 border-t border-dashed border-ink/10 pt-5">
            <p className="text-xs leading-5 text-ink-soft">{t('webSearch.customHint')}</p>
            <Field label={t('webSearch.baseUrl')} value={selected.config.baseUrl || ''} onChange={(value) => updateConfig('baseUrl', value)} placeholder="https://search.example.com/v1/search" />
            <label className="flex min-w-0 flex-col gap-1.5 text-xs text-ink-soft"><span>{t('webSearch.method')}</span><select value={selected.config.method || 'POST'} onChange={(event) => updateConfig('method', event.target.value)} className="h-10 min-w-0 w-full rounded-lg border border-ink/15 bg-paper px-3.5 text-sm text-ink outline-none transition-colors hover:border-ink/25 focus:border-focus focus:ring-2 focus:ring-focus/15"><option value="POST">POST</option><option value="GET">GET</option></select></label>
            {(selected.config.method || 'POST') === 'GET' ? <Field label={t('webSearch.queryParam')} value={selected.config.queryParam || 'q'} onChange={(value) => updateConfig('queryParam', value)} /> : null}
            <Field multiline label={t('webSearch.headersTemplate')} value={selected.config.headersTemplate ?? CUSTOM_DEFAULTS.headersTemplate} onChange={(value) => updateConfig('headersTemplate', value)} />
            {(selected.config.method || 'POST') === 'POST' ? <Field multiline label={t('webSearch.bodyTemplate')} value={selected.config.bodyTemplate ?? CUSTOM_DEFAULTS.bodyTemplate} onChange={(value) => updateConfig('bodyTemplate', value)} /> : null}
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"><Field label={t('webSearch.resultPath')} value={selected.config.resultPath || 'results'} onChange={(value) => updateConfig('resultPath', value)} /><Field label={t('webSearch.titlePath')} value={selected.config.titlePath || 'title'} onChange={(value) => updateConfig('titlePath', value)} /><Field label={t('webSearch.urlPath')} value={selected.config.urlPath || 'url'} onChange={(value) => updateConfig('urlPath', value)} /><Field label={t('webSearch.snippetPath')} value={selected.config.snippetPath || 'snippet'} onChange={(value) => updateConfig('snippetPath', value)} /></div>
            <p className="font-mono text-[10px] text-ink-fade">{t('webSearch.placeholders')}</p>
          </div> : null}
        </div> : null}
      </div>
    </div>
    {lastTest ? <div className={`rounded-xl border px-5 py-4 text-sm ${lastTest.ok ? 'border-success/20 bg-success/10 text-success' : 'border-danger/20 bg-danger/5 text-danger'}`}>{lastTest.ok ? t('webSearch.lastTestOk') : t('webSearch.lastTestFailed')}{lastTest.message ? ` - ${lastTest.message}` : ''}</div> : null}
    {message ? <div role="status" className="text-sm text-ink-soft">{message}</div> : null}
    <div className="flex flex-wrap gap-3"><button type="button" disabled={Boolean(working)} onClick={() => save()} className="h-10 rounded-lg border border-ink/15 bg-paper px-5 text-sm text-ink transition-colors hover:bg-paper-2 disabled:opacity-50">{working === 'save' ? t('common.saving') : t('common.save')}</button><button type="button" disabled={Boolean(working)} onClick={() => save({ test: true })} className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-5 text-sm text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"><Search className="h-4 w-4" />{working === 'test' ? t('webSearch.testing') : t('webSearch.saveAndTest')}</button>{connections.some((item) => item.apiKeyPresent) ? <button type="button" disabled={Boolean(working)} onClick={clear} className="ml-auto h-10 rounded-lg px-4 text-sm text-danger hover:bg-danger/5 disabled:opacity-50"><KeyRound className="mr-1 inline h-4 w-4" />{t('webSearch.clear')}</button> : null}</div>
  </section>
}
