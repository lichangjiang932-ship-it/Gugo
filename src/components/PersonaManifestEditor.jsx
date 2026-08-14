import { splitPersonaManifestIds } from '../lib/personaManifest.js'

const DEFAULT_MANIFEST = {
  version: 1,
  capabilityIds: [],
  recommendedConnectorIds: [],
  defaultPermissionMode: 'bypass',
}

export default function PersonaManifestEditor({ value, onChange, t }) {
  const manifest = { ...DEFAULT_MANIFEST, ...(value || {}) }
  const update = (patch) => onChange({ ...manifest, ...patch, version: 1 })

  return (
    <section className="border border-ink/10 rounded-md p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-ink">{t('agents.manifestTitle')}</h3>
        <p className="text-xs text-ink-fade mt-1">{t('agents.manifestHint')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldCapabilities')}</label>
          <textarea
            defaultValue={manifest.capabilityIds.join('\n')}
            onChange={(event) => update({ capabilityIds: splitPersonaManifestIds(event.target.value) })}
            rows={4}
            className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm font-mono"
            placeholder={t('agents.capabilitiesPlaceholder')}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldConnectors')}</label>
          <textarea
            defaultValue={manifest.recommendedConnectorIds.join('\n')}
            onChange={(event) => update({ recommendedConnectorIds: splitPersonaManifestIds(event.target.value) })}
            rows={4}
            className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm font-mono"
            placeholder={t('agents.connectorsPlaceholder')}
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-ink-fade mb-1">{t('agents.fieldPermissionMode')}</label>
        <select
          value={manifest.defaultPermissionMode}
          onChange={(event) => update({ defaultPermissionMode: event.target.value })}
          className="w-full px-3 py-2 border border-ink/15 rounded bg-canvas text-ink text-sm"
        >
          <option value="normal">{t('agents.permissionNormal')}</option>
          <option value="acceptEdits">{t('agents.permissionAcceptEdits')}</option>
          <option value="plan">{t('agents.permissionPlan')}</option>
          <option value="bypass">{t('agents.permissionBypass')}</option>
        </select>
        <p className="text-xs text-ink-fade mt-1">{t('agents.permissionModeHint')}</p>
      </div>
    </section>
  )
}
