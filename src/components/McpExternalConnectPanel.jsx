import { useState } from 'react'
import { Check, Copy, ExternalLink, KeyRound } from 'lucide-react'
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
    <section className="mt-4 overflow-hidden rounded-lg border border-ink/10 bg-paper" aria-labelledby="mcp-external-title">
      <div className="flex items-start gap-3 border-b border-ink/10 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div id="mcp-external-title" className="text-sm font-semibold text-ink">{t('mcpExternal.title')}</div>
          <div className="mt-0.5 text-xs leading-5 text-ink-fade">{t('mcpExternal.instruction')}</div>
        </div>
        <button type="button" onClick={() => navigate('/mobile-keys')} className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg border border-ink/10 bg-paper px-2.5 text-xs text-ink-soft transition-colors hover:bg-paper-2/55 hover:text-ink">
          <KeyRound className="w-3.5 h-3.5" />
          {t('mcpExternal.createKey')}
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(360px,1.3fr)]">
        <div className="space-y-2.5">
          <label className="block text-xs text-ink-fade">
            {t('mcpExternal.endpoint')}
            <input value={endpoint} readOnly className="mt-1 h-9 w-full rounded-lg border border-ink/10 bg-paper-2/45 px-2.5 font-mono text-xs text-ink-soft outline-none" />
          </label>
          <label className="block text-xs text-ink-fade">
            {t('mcpExternal.keyLabel')}
            <input
              type="password"
              value={accessKey}
              onChange={(event) => { setAccessKey(event.target.value); setCopyState('idle') }}
              autoComplete="off"
              spellCheck="false"
              placeholder="ymak_..."
              className={`mt-1 h-9 w-full rounded-lg border bg-paper-2/45 px-2.5 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-fade/70 ${validKey ? 'border-ink/10 hover:border-ink/15 focus:border-focus/55' : 'border-danger/40'}`}
            />
          </label>
          <div className={`text-xs ${validKey ? 'text-ink-fade' : 'text-danger'}`}>
            {validKey ? t('mcpExternal.keyPrivacy') : t('mcpExternal.invalidKey')}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap gap-1" aria-label={t('mcpExternal.appLabel')}>
            {MCP_EXTERNAL_APPS.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => { setAppId(app.id); setCopyState('idle') }}
                aria-pressed={appId === app.id}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${appId === app.id ? 'border-ink/15 bg-ink/[0.055] text-ink' : 'border-transparent text-ink-fade hover:bg-ink/[0.035] hover:text-ink'}`}
              >
                {app.label}
              </button>
            ))}
          </div>
          <pre className="mt-2 h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-ink/10 bg-ink/[0.025] p-2.5 font-mono text-xs text-ink-soft">{config}</pre>
          <div className="flex items-center justify-between gap-3 mt-2">
            <span className={`text-xs ${copyState === 'error' ? 'text-danger' : 'text-ink-fade'}`} role="status">
              {copyState === 'error' ? t('mcpExternal.copyError') : t('mcpExternal.configHint')}
            </span>
            <button type="button" onClick={copyConfig} disabled={!validKey} className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg border border-ink bg-ink px-3 text-xs text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-45">
              {copyState === 'copied' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copyState === 'copied' ? t('mcpExternal.copied') : t('mcpExternal.copy')}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
