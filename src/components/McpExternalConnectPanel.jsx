import { useState } from 'react'
import { Check, Copy, ExternalLink, Globe, KeyRound } from 'lucide-react'
import { useNavigate } from '../lib/router.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  buildExternalMcpConfig,
  isValidMcpAccessKey,
  MCP_EXTERNAL_APPS,
} from '../lib/mcpExternalConfig.js'

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed')
  } finally {
    textarea.remove()
  }
}

export default function McpExternalConnectPanel({ endpoint }) {
  const { t } = useT()
  const navigate = useNavigate()
  const [appId, setAppId] = useState('claude')
  const [accessKey, setAccessKey] = useState('')
  const [copyState, setCopyState] = useState('idle')
  const validKey = isValidMcpAccessKey(accessKey)
  const config = buildExternalMcpConfig(appId, endpoint, accessKey)

  const copyConfig = async () => {
    try {
      await copyToClipboard(config)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  return (
    <section className="mx-6 mt-4 p-4 border border-ink/15 rounded-lg bg-paper-2" aria-labelledby="mcp-external-title">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-ember/10 text-ember flex items-center justify-center shrink-0">
          <Globe className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div id="mcp-external-title" className="text-sm font-semibold text-ink">{t('mcpExternal.title')}</div>
          <div className="text-[11px] text-ink-fade mt-0.5">{t('mcpExternal.instruction')}</div>
        </div>
        <button type="button" onClick={() => navigate('/mobile-keys')} className="h-8 px-2.5 border border-ink/15 rounded-md text-xs text-ink-soft hover:border-ember/40 hover:text-ember flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5" />
          {t('mcpExternal.createKey')}
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(220px,0.7fr)_minmax(360px,1.3fr)] gap-3 mt-3">
        <div className="space-y-2.5">
          <label className="block text-[11px] text-ink-fade">
            {t('mcpExternal.endpoint')}
            <input value={endpoint} readOnly className="w-full h-8 mt-1 px-2.5 text-xs font-mono bg-paper border border-ink/10 rounded-md text-ink-soft" />
          </label>
          <label className="block text-[11px] text-ink-fade">
            {t('mcpExternal.keyLabel')}
            <input
              type="password"
              value={accessKey}
              onChange={(event) => { setAccessKey(event.target.value); setCopyState('idle') }}
              autoComplete="off"
              spellCheck="false"
              placeholder="ymak_..."
              className={`w-full h-8 mt-1 px-2.5 text-xs font-mono bg-paper border rounded-md outline-none ${validKey ? 'border-ink/10 focus:border-ember/50' : 'border-rose-400'}`}
            />
          </label>
          <div className={`text-[10px] ${validKey ? 'text-ink-fade' : 'text-rose-700'}`}>
            {validKey ? t('mcpExternal.keyPrivacy') : t('mcpExternal.invalidKey')}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap gap-1.5" aria-label={t('mcpExternal.appLabel')}>
            {MCP_EXTERNAL_APPS.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => { setAppId(app.id); setCopyState('idle') }}
                aria-pressed={appId === app.id}
                className={`px-2 py-1 rounded-md border text-[10px] transition-colors ${appId === app.id ? 'border-ember bg-ember/10 text-ember' : 'border-ink/15 text-ink-fade hover:border-ember/40 hover:text-ink'}`}
              >
                {app.label}
              </button>
            ))}
          </div>
          <pre className="mt-2 h-28 overflow-auto whitespace-pre-wrap break-all text-[10px] bg-paper border border-ink/10 rounded-md p-2.5 text-ink-soft">{config}</pre>
          <div className="flex items-center justify-between gap-3 mt-2">
            <span className={`text-[10px] ${copyState === 'error' ? 'text-rose-700' : 'text-ink-fade'}`} role="status">
              {copyState === 'error' ? t('mcpExternal.copyError') : t('mcpExternal.configHint')}
            </span>
            <button type="button" onClick={copyConfig} disabled={!validKey} className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 disabled:opacity-50 flex items-center gap-1.5 shrink-0">
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copyState === 'copied' ? t('mcpExternal.copied') : t('mcpExternal.copy')}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
