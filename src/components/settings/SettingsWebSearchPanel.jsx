import { ExternalLink, KeyRound, Search, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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

function Field({ label, value, onChange, placeholder = '', multiline = false, type = 'text' }) {
  const className = 'w-full rounded-md border border-ink-fade/50 bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-ember'
  return <label className="flex flex-col gap-1.5 text-xs text-ink-soft"><span>{label}</span>{multiline
    ? <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={`${className} resize-y font-mono text-xs`} />
    : <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={className} />}</label>
}

function Toggle({ enabled, onChange, label }) {
  return <button type="button" role="switch" aria-checked={enabled} aria-label={label} onClick={() => onChange(!enabled)} className={`relative h-6 w-11 rounded-full border transition-colors ${enabled ? 'border-ember bg-ember' : 'border-ink-fade/60 bg-paper-2'}`}><span className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-paper transition-all ${enabled ? 'left-[21px]' : 'left-0.5'}`} /></button>
}

export default function SettingsWebSearchPanel({ t }) {
  const [provider, setProvider] = useState('tavily')
  const [enabled, setEnabled] = useState(true)
  const [config, setConfig] = useState({})
  const [apiKey, setApiKey] = useState('')
  const [apiKeyPresent, setApiKeyPresent] = useState(false)
  const [lastTest, setLastTest] = useState(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState('')
  const [message, setMessage] = useState('')

  const meta = useMemo(() => WEB_SEARCH_PROVIDERS.find((item) => item.id === provider) || WEB_SEARCH_PROVIDERS[0], [provider])
  const updateConfig = (key, value) => setConfig((current) => ({ ...current, [key]: value }))

  useEffect(() => {
    let active = true
    getWebSearchConfigApi().then((data) => {
      if (!active || !data.config) return
      setProvider(data.config.provider || 'tavily')
      setEnabled(data.config.enabled !== false)
      setConfig(data.config.config || {})
      setApiKeyPresent(Boolean(data.config.apiKeyPresent))
      setLastTest(data.config.lastTest || null)
    }).catch((error) => { if (active) setMessage(error.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const payload = () => ({
    provider,
    enabled,
    config: provider === 'custom' ? { ...CUSTOM_DEFAULTS, ...config } : config,
    ...(apiKey ? { apiKey } : {}),
  })

  const save = async ({ test = false } = {}) => {
    setWorking(test ? 'test' : 'save'); setMessage('')
    try {
      const saved = await saveWebSearchConfigApi(payload())
      setApiKey(''); setApiKeyPresent(Boolean(saved.config?.apiKeyPresent)); setLastTest(saved.config?.lastTest || null)
      if (test) {
        const tested = await testWebSearchApi()
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
      setProvider('tavily'); setEnabled(true); setConfig({}); setApiKey(''); setApiKeyPresent(false); setLastTest(null)
      setMessage(t('webSearch.cleared'))
    } catch (error) { setMessage(t('webSearch.failed', { message: error.message })) }
    finally { setWorking('') }
  }

  if (loading) return <div className="text-sm text-ink-fade">{t('common.loading')}</div>

  return <section className="flex flex-col gap-5 animate-float-up">
    <div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">WEB SEARCH</span><h1 className="font-hand text-[28px] text-ink mt-1.5">{t('webSearch.title')}</h1><p className="text-sm text-ink-soft mt-1">{t('webSearch.subtitle')}</p></div>
    <div className="rounded-xl border border-ink/20 bg-paper p-5 flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-emerald-600" /><p className="text-xs text-ink-soft flex-1">{t('webSearch.security')}</p><Toggle enabled={enabled} onChange={setEnabled} label={t('webSearch.enabled')} /></div>
    <div className="rounded-xl border border-ink/20 bg-paper p-5 flex flex-col gap-4">
      <div><h2 className="text-base text-ink">{t('webSearch.provider')}</h2><p className="text-xs text-ink-fade mt-1">{t('webSearch.providerHint')}</p></div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">{WEB_SEARCH_PROVIDERS.map((item) => <button key={item.id} type="button" onClick={() => { if (item.id !== provider) { setApiKey(''); setApiKeyPresent(false); setConfig({}) } setProvider(item.id); setMessage('') }} className={`rounded-lg border p-3 text-left transition-colors ${provider === item.id ? 'border-ember bg-ember-soft/50' : 'border-ink-fade/40 hover:bg-paper-2'}`}><span className="block text-sm text-ink">{item.label}</span><span className="mt-1 block text-[10px] text-ink-fade">{item.id === 'custom' ? t('webSearch.customBadge') : t('webSearch.presetBadge')}</span></button>)}</div>
      {meta.docsUrl ? <a href={meta.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ember self-start">{t('webSearch.getApiKey')}<ExternalLink className="h-3 w-3" /></a> : null}
      <Field type="password" label={t('webSearch.apiKey')} value={apiKey} onChange={setApiKey} placeholder={apiKeyPresent ? t('webSearch.secretKept') : t('webSearch.apiKeyPlaceholder')} />
      {provider === 'google_cse' ? <Field label={t('webSearch.googleCx')} value={config.cx || ''} onChange={(value) => updateConfig('cx', value)} placeholder="0123456789:abcdef" /> : null}
      {provider === 'custom' ? <div className="grid gap-3 border-t border-dashed border-ink-fade/40 pt-4">
        <p className="text-xs text-ink-fade">{t('webSearch.customHint')}</p>
        <Field label={t('webSearch.baseUrl')} value={config.baseUrl || ''} onChange={(value) => updateConfig('baseUrl', value)} placeholder="https://search.example.com/v1/search" />
        <label className="flex flex-col gap-1.5 text-xs text-ink-soft"><span>{t('webSearch.method')}</span><select value={config.method || 'POST'} onChange={(event) => updateConfig('method', event.target.value)} className="h-9 rounded-md border border-ink-fade/50 bg-paper px-3 text-sm text-ink"><option value="POST">POST</option><option value="GET">GET</option></select></label>
        {(config.method || 'POST') === 'GET' ? <Field label={t('webSearch.queryParam')} value={config.queryParam || 'q'} onChange={(value) => updateConfig('queryParam', value)} /> : null}
        <Field multiline label={t('webSearch.headersTemplate')} value={config.headersTemplate ?? CUSTOM_DEFAULTS.headersTemplate} onChange={(value) => updateConfig('headersTemplate', value)} />
        {(config.method || 'POST') === 'POST' ? <Field multiline label={t('webSearch.bodyTemplate')} value={config.bodyTemplate ?? CUSTOM_DEFAULTS.bodyTemplate} onChange={(value) => updateConfig('bodyTemplate', value)} /> : null}
        <div className="grid grid-cols-2 gap-3"><Field label={t('webSearch.resultPath')} value={config.resultPath || 'results'} onChange={(value) => updateConfig('resultPath', value)} /><Field label={t('webSearch.titlePath')} value={config.titlePath || 'title'} onChange={(value) => updateConfig('titlePath', value)} /><Field label={t('webSearch.urlPath')} value={config.urlPath || 'url'} onChange={(value) => updateConfig('urlPath', value)} /><Field label={t('webSearch.snippetPath')} value={config.snippetPath || 'snippet'} onChange={(value) => updateConfig('snippetPath', value)} /></div>
        <p className="font-mono text-[10px] text-ink-fade">{t('webSearch.placeholders')}</p>
      </div> : null}
    </div>
    {lastTest ? <div className={`rounded-lg border px-4 py-3 text-sm ${lastTest.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-700'}`}>{lastTest.ok ? t('webSearch.lastTestOk') : t('webSearch.lastTestFailed')}{lastTest.message ? ` - ${lastTest.message}` : ''}</div> : null}
    {message ? <div role="status" className="text-sm text-ink-soft">{message}</div> : null}
    <div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(working)} onClick={() => save()} className="h-10 px-4 rounded-md border border-ink/30 text-sm text-ink disabled:opacity-50">{working === 'save' ? t('common.saving') : t('common.save')}</button><button type="button" disabled={Boolean(working)} onClick={() => save({ test: true })} className="h-10 px-4 rounded-md bg-ink text-paper text-sm inline-flex items-center gap-2 disabled:opacity-50"><Search className="h-4 w-4" />{working === 'test' ? t('webSearch.testing') : t('webSearch.saveAndTest')}</button>{apiKeyPresent ? <button type="button" disabled={Boolean(working)} onClick={clear} className="h-10 px-4 rounded-md text-sm text-red-600 ml-auto disabled:opacity-50"><KeyRound className="h-4 w-4 inline mr-1" />{t('webSearch.clear')}</button> : null}</div>
  </section>
}
