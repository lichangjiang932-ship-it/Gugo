import { Globe, Plug, Plus } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import McpExternalConnectPanel from '../components/McpExternalConnectPanel.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { MCP_SERVER_PRESETS } from '../lib/mcpPresets.js'
import McpServerEditor from './mcp/McpServerEditor.jsx'
import McpServerList from './mcp/McpServerList.jsx'
import { emptyServer, formFromServer } from './mcp/mcpServerForm.js'
import useMcpServersController from './mcp/useMcpServersController.js'

export default function McpServersView() {
  const { t } = useT()
  const controller = useMcpServersController(t)
  const externalEndpoint = `${window.location.origin}/mcp`

  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      <LeftRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-ink/10 px-6 py-4">
          <Plug className="h-5 w-5 text-ember" />
          <div className="flex-1"><div className="text-base font-semibold text-ink">{t('mcp.title')}</div><div className="text-[11px] text-ink-fade">{t('mcp.subtitle')}</div></div>
          <label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ember/30 px-2 text-xs text-ember hover:bg-ember/10">
            <Globe className="h-3.5 w-3.5" />
            <select value={controller.presetChoice} onChange={(event) => controller.choosePreset(event.target.value)} className="max-w-40 bg-transparent outline-none" aria-label={t('mcp.choosePreset')}>
              <option value="">{t('mcp.choosePreset')}</option>
              {MCP_SERVER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => { controller.setEditing(formFromServer(emptyServer())); controller.setFieldErrors({}) }} className="flex h-8 items-center gap-1 rounded-md bg-ember px-3 text-xs text-paper hover:bg-ember/90"><Plus className="h-3.5 w-3.5" />{t('mcp.addServer')}</button>
        </div>
        <McpExternalConnectPanel endpoint={externalEndpoint} />
        <div className="flex min-h-0 flex-1">
          <McpServerList controller={controller} t={t} />
          <div className="flex-1 overflow-auto"><McpServerEditor controller={controller} t={t} /></div>
        </div>
      </div>
    </div>
  )
}
