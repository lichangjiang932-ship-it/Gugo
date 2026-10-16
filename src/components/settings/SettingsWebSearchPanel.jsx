import { ArrowDown, ArrowUp, Check, ExternalLink, KeyRound, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WEB_SEARCH_PROVIDERS } from '../../../shared/webSearchProviders.js'
import {
  deleteWebSearchConfigApi,
  getWebSearchConfigApi,
  saveWebSearchConfigApi,
  testWebSearchApi,
} from '../../lib/webSearchClient.js'
import { SettingsGroup, SettingsPanel, SettingsRow, SettingsToggle } from './SettingsPrimitives.jsx'

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
  return <label className="text-xs font-semibold">{label}{multiline
    ? <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="settings-input mt-2 w-full resize-y font-mono" />
    : <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="settings-input mt-2 w-full" />}</label>
}

function BrandMark({ item, size = 'md' }) {
  return <span className={`grid shrink-0 place-items-center rounded text-xs font-semibold ${size === 'lg' ? 'h-7 w-7' : 'h-6 w-6'} ${item?.accent || 'bg-ink-fade/15 text-ink-soft'}`}>{item?.initial || '·'}</span>
}

/**
 * The web search tab, on the same primitives as every other settings tab.
 *
 * It used to be its own thing: a mono uppercase eyebrow, 9px and 10px labels,
 * taller rounded-xl cards, a private toggle and a private text field, and a
 * filled ink button where the rest of settings use the accent. The dialog even
 * carried `:has(.web-search-settings)` overrides to recolour its own toolbar for
 * this one tab — a panel that has to restyle the chrome around it is the panel
 * that does not match. Everything here now comes from SettingsPrimitives and the
 * settings-* control classes, and those overrides are gone.
 */
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

  return (
    <SettingsPanel
      className="web-search-settings"
      title={t('webSearch.title')}
      description={t('webSearch.subtitle')}
    >
      <SettingsGroup>
        <SettingsRow title={t('webSearch.enabled')} description={t('webSearch.security')}>
          <SettingsToggle checked={enabled} onChange={setEnabled} label={t('webSearch.enabled')} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('webSearch.provider')} description={t('webSearch.fallbackHint')}>
        <div className="web-search-settings-split min-w-0">
          <div className="flex min-w-0 flex-col gap-2" data-testid="web-search-connections">
            {connections.map((item, index) => {
              const providerMeta = WEB_SEARCH_PROVIDERS.find((candidate) => candidate.id === item.provider)
              const active = item.id === selected?.id
              return <div key={item.id} className={`min-w-0 rounded-lg border p-3 transition-colors ${active ? 'border-ink/25 bg-paper-2' : 'border-ink/10 bg-paper hover:bg-paper-2/60'}`}>
                <button type="button" onClick={() => { setSelectedId(item.id); setMessage('') }} className="flex w-full items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30">
                  <BrandMark item={providerMeta} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[0.8125rem] font-medium ${active ? 'text-ink' : 'text-ink-soft'}`}>{providerMeta?.label || item.provider}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-fade">
                      <span className={`h-1.5 w-1.5 rounded-full ${item.enabled ? 'bg-success' : 'bg-ink-fade'}`} />
                      {t('webSearch.priority', { index: index + 1 })} · {item.apiKeyPresent ? t('webSearch.keySaved') : t('webSearch.keyMissing')}
                    </span>
                  </span>
                </button>
                {connections.length > 1 ? <div className="mt-2.5 flex items-center gap-1 border-t border-ink/10 pt-2" data-testid="web-search-connection-actions">
                  <button type="button" disabled={index === 0} onClick={() => moveConnection(item.id, -1)} aria-label={t('webSearch.moveUp')} className="rounded-md p-1.5 text-ink-fade hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-25"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" disabled={index === connections.length - 1} onClick={() => moveConnection(item.id, 1)} aria-label={t('webSearch.moveDown')} className="rounded-md p-1.5 text-ink-fade hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-25"><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => removeConnection(item.id)} aria-label={t('webSearch.removeApi')} className="ml-auto rounded-md p-1.5 text-danger hover:bg-danger/10"><Trash2 className="h-3.5 w-3.5" /></button>
                </div> : null}
              </div>
            })}
            <button type="button" onClick={addConnection} disabled={connections.length >= 8 || Boolean(working)} className="settings-action-button w-full"><Plus className="h-3.5 w-3.5" />{t('webSearch.addApi')}</button>
          </div>

          {selected ? <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-ink/10 bg-paper p-4" data-testid="web-search-connection-editor">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <BrandMark item={meta} size="lg" />
                <div className="min-w-0">
                  <h3 className="truncate text-[0.8125rem] font-medium text-ink">{meta.label}</h3>
                  <p className="text-xs text-ink-fade">{t('webSearch.apiSettings')} · {t('webSearch.priority', { index: selectedIndex + 1 })}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="settings-inline-status">{t('webSearch.useThisApi')}</span>
                <SettingsToggle checked={selected.enabled} onChange={(value) => replaceConnection(selected.id, (item) => ({ ...item, enabled: value }))} label={t('webSearch.useThisApi')} />
              </div>
            </div>

            <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-3" data-testid="web-search-template-grid">{WEB_SEARCH_PROVIDERS.map((item) => {
              const chosen = selected.provider === item.id
              return <button key={item.id} type="button" data-provider={item.id} onClick={() => replaceConnection(selected.id, (current) => item.id === current.provider ? current : { ...current, provider: item.id, config: {}, apiKey: '', apiKeyPresent: false })} className={`relative min-w-0 rounded-lg border bg-paper p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 ${chosen ? 'border-ink/25 bg-paper-2' : 'border-ink/10 hover:border-ink/20 hover:bg-paper-2/60'}`}>
                {chosen && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent" />}
                <span className="flex min-w-0 flex-col gap-1.5">
                  <BrandMark item={item} />
                  <span className="min-w-0 pr-1">
                    <span className="block min-h-8 whitespace-normal break-words text-xs leading-4 text-ink">{item.label}</span>
                    <span className="mt-0.5 block text-xs text-ink-fade">{item.id === 'custom' ? t('webSearch.customBadge') : t('webSearch.presetBadge')}</span>
                  </span>
                </span>
              </button>
            })}</div>

            {meta.docsUrl ? <a href={meta.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-xs text-accent-ink hover:underline">{t('webSearch.getApiKey')}<ExternalLink className="h-3 w-3" /></a> : null}
            <Field type="password" label={t('webSearch.apiKey')} value={selected.apiKey} onChange={(value) => replaceConnection(selected.id, (item) => ({ ...item, apiKey: value }))} placeholder={selected.apiKeyPresent ? t('webSearch.secretKept') : t('webSearch.apiKeyPlaceholder')} />
            {selected.provider === 'google_cse' ? <Field label={t('webSearch.googleCx')} value={selected.config.cx || ''} onChange={(value) => updateConfig('cx', value)} placeholder="0123456789:abcdef" /> : null}
            {selected.provider === 'custom' ? <div className="grid gap-3 border-t border-ink/10 pt-4">
              <p className="settings-inline-status">{t('webSearch.customHint')}</p>
              <Field label={t('webSearch.baseUrl')} value={selected.config.baseUrl || ''} onChange={(value) => updateConfig('baseUrl', value)} placeholder="https://search.example.com/v1/search" />
              <label className="text-xs font-semibold">{t('webSearch.method')}<select value={selected.config.method || 'POST'} onChange={(event) => updateConfig('method', event.target.value)} className="settings-select mt-2 w-full"><option value="POST">POST</option><option value="GET">GET</option></select></label>
              {(selected.config.method || 'POST') === 'GET' ? <Field label={t('webSearch.queryParam')} value={selected.config.queryParam || 'q'} onChange={(value) => updateConfig('queryParam', value)} /> : null}
              <Field multiline label={t('webSearch.headersTemplate')} value={selected.config.headersTemplate ?? CUSTOM_DEFAULTS.headersTemplate} onChange={(value) => updateConfig('headersTemplate', value)} />
              {(selected.config.method || 'POST') === 'POST' ? <Field multiline label={t('webSearch.bodyTemplate')} value={selected.config.bodyTemplate ?? CUSTOM_DEFAULTS.bodyTemplate} onChange={(value) => updateConfig('bodyTemplate', value)} /> : null}
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"><Field label={t('webSearch.resultPath')} value={selected.config.resultPath || 'results'} onChange={(value) => updateConfig('resultPath', value)} /><Field label={t('webSearch.titlePath')} value={selected.config.titlePath || 'title'} onChange={(value) => updateConfig('titlePath', value)} /><Field label={t('webSearch.urlPath')} value={selected.config.urlPath || 'url'} onChange={(value) => updateConfig('urlPath', value)} /><Field label={t('webSearch.snippetPath')} value={selected.config.snippetPath || 'snippet'} onChange={(value) => updateConfig('snippetPath', value)} /></div>
              <p className="font-mono text-xs text-ink-fade">{t('webSearch.placeholders')}</p>
            </div> : null}
          </div> : null}
        </div>
      </SettingsGroup>

      {lastTest ? <p className={`settings-inline-status ${lastTest.ok ? 'text-success' : 'text-danger'}`}>{lastTest.ok ? t('webSearch.lastTestOk') : t('webSearch.lastTestFailed')}{lastTest.message ? ` - ${lastTest.message}` : ''}</p> : null}
      {message ? <p role="status" className="settings-inline-status">{message}</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={Boolean(working)} onClick={() => save()} className="settings-action-button">{working === 'save' ? t('common.saving') : t('common.save')}</button>
        <button type="button" disabled={Boolean(working)} onClick={() => save({ test: true })} className="settings-action-button settings-action-button-primary"><Search className="h-3.5 w-3.5" />{working === 'test' ? t('webSearch.testing') : t('webSearch.saveAndTest')}</button>
        {connections.some((item) => item.apiKeyPresent) ? <button type="button" disabled={Boolean(working)} onClick={clear} className="settings-action-button ml-auto text-danger"><KeyRound className="h-3.5 w-3.5" />{t('webSearch.clear')}</button> : null}
      </div>
    </SettingsPanel>
  )
}
