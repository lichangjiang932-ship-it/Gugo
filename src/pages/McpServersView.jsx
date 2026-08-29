import { useState } from 'react'
import { Plus } from 'lucide-react'
import AppLayout from '../components/AppLayout.jsx'
import McpExternalConnectPanel from '../components/McpExternalConnectPanel.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { parseMcpImportJson } from '../lib/mcpImport.js'
import { MCP_SERVER_PRESETS } from '../lib/mcpPresets.js'
import McpServerEditor from './mcp/McpServerEditor.jsx'
import McpServerList from './mcp/McpServerList.jsx'
import { emptyServer, formFromServer } from './mcp/mcpServerForm.js'
import useMcpServersController from './mcp/useMcpServersController.js'

const IMPORT_PLACEHOLDER = '{"mcpServers":{"github":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"]}}}'

export default function McpServersView() {
  const { t } = useT()
  const controller = useMcpServersController(t)
  const externalEndpoint = `${window.location.origin}/mcp`
  const [importText, setImportText] = useState('')
  const [importMessage, setImportMessage] = useState('')
  const [importing, setImporting] = useState(false)

  const runImport = async () => {
    setImportMessage('')
    let parsed
    try { parsed = parseMcpImportJson(importText) }
    catch (error) { setImportMessage(t('mcp.importJsonError', { message: error.message })); return }
    if (!parsed.servers.length) { setImportMessage(t('mcp.importJsonEmpty')); return }
    setImporting(true)
    try {
      const result = await controller.importParsedServers(parsed.servers)
      const suffix = result.errors.length ? ` · ${result.errors.join('; ')}` : ''
      setImportMessage(t('mcp.importJsonSuccess', { count: result.imported }) + suffix)
      if (!result.errors.length) setImportText('')
    } catch (error) {
      setImportMessage(t('mcp.importJsonError', { message: error.message }))
    } finally { setImporting(false) }
  }

  return (
    <AppLayout className="flex h-screen overflow-hidden bg-paper">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-6 py-7 lg:px-9 lg:py-8">
          <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-[21px] font-semibold leading-tight tracking-[-0.025em] text-ink">{t('mcp.title')}</h1>
              <p className="mt-1 text-xs leading-5 text-ink-fade">{t('mcp.subtitle')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={controller.presetChoice}
                onChange={(event) => controller.choosePreset(event.target.value)}
                className="h-9 max-w-52 rounded-lg border border-ink/10 bg-paper px-3 text-xs text-ink-soft outline-none transition-colors hover:bg-paper-2/40 focus:border-focus/55"
                aria-label={t('mcp.choosePreset')}
              >
                <option value="">{t('mcp.choosePreset')}</option>
                {MCP_SERVER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
              <button
                type="button"
                onClick={() => { controller.setEditing(formFromServer(emptyServer())); controller.setFieldErrors({}) }}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink bg-ink px-3 text-xs font-medium text-paper transition-colors hover:bg-ink/90"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('mcp.addServer')}
              </button>
            </div>
          </header>

          <details className="mb-4 rounded-lg border border-ink/10 bg-paper px-5 py-3">
            <summary className="cursor-pointer select-none text-xs font-medium text-ink-soft transition-colors hover:text-ink">{t('mcp.importJsonTitle')}</summary>
            <p className="mt-2 text-[11px] leading-4 text-ink-fade">{t('mcp.importJsonHint')}</p>
            <textarea
              rows="4"
              value={importText}
              onChange={(event) => { setImportText(event.target.value); setImportMessage('') }}
              placeholder={IMPORT_PLACEHOLDER}
              spellCheck="false"
              className="mt-2 w-full resize-y rounded-lg border border-ink/10 bg-paper-2/45 px-3 py-2 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-fade/70 hover:border-ink/15 focus:border-focus/55"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runImport}
                disabled={!importText.trim() || importing}
                className="inline-flex h-8 items-center rounded-lg border border-ink bg-ink px-3 text-xs font-medium text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {importing ? t('mcp.saving') : t('mcp.importJsonAction')}
              </button>
              {importMessage && <span className="text-[11px] leading-4 text-ink-fade">{importMessage}</span>}
            </div>
          </details>

          <div className="grid min-h-[430px] grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <McpServerList controller={controller} t={t} />
            <McpServerEditor controller={controller} t={t} />
          </div>

          <McpExternalConnectPanel endpoint={externalEndpoint} />
        </div>
      </main>
    </AppLayout>
  )
}
