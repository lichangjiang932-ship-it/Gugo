import { ShieldCheck } from 'lucide-react'
import { SectionTitle } from './PermissionSectionPrimitives.jsx'

export function WorkspaceTrustSection({ controller, t }) {
  const grants = (controller.localFiles?.grants || []).filter((grant) => grant.resourceType === 'directory')
  return (
    <><SectionTitle eyebrow="WORKSPACE TRUST" title={t('localFiles.workspaceTrustManage')} /><p className="mb-2 text-xs text-ink-fade">{t('localFiles.workspaceTrustManageHint')}</p>{controller.localFileError && <div className="mb-3 rounded-md border border-dashed border-accent/60 px-4 py-2.5 text-sm text-accent-ink">{controller.localFileError}</div>}<div className="mb-6 overflow-hidden rounded-md border border-ink/30">{grants.length === 0 ? <div className="px-4 py-5 text-sm text-ink-fade">{t('localFiles.workspaceTrustEmpty')}</div> : grants.map((grant, index) => <WorkspaceTrustRow key={grant.id} controller={controller} grant={grant} last={index === grants.length - 1} t={t} />)}</div></>
  )
}

function WorkspaceTrustRow({ controller, grant, last, t }) {
  const trust = (controller.localFiles?.trustedWorkspaces || []).find((item) => String(item.rootPath || '').toLowerCase() === String(grant.path || '').toLowerCase())
  const trusted = !!trust?.trusted
  const trustPath = trusted ? trust?.trustRootPath || grant.path : grant.path
  const trustScope = trusted
    ? (trust?.trustScope === 'session' ? 'session' : 'persistent')
    : (grant.scope === 'session' ? 'session' : 'persistent')
  const busy = controller.trustBusyPath === trustPath
  return (
    <div className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${!last ? 'border-b border-dashed border-ink-fade/40' : ''}`}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${trusted ? 'border-success/40 bg-success/5 text-success' : 'border-ink-fade/50 bg-paper-2 text-ink-fade'}`}>
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink" title={grant.path}>{grant.path}</div>
          <div className="mt-1 text-xs text-ink-fade">
            {trusted ? t('localFiles.workspaceTrusted') : t('localFiles.workspaceTrustOff')}
            {` · ${grant.scope === 'session' ? 'session' : 'persistent'}`}
            {trust?.inherited ? ` · inherited from ${trust.trustRootPath}` : ''}
            {trusted && trust?.config?.present === false ? ` · ${t('localFiles.workspaceConfigMissing')}` : ''}
            {trusted && trust?.config?.valid === false ? ` · ${trust.config.error?.message || t('localFiles.workspaceConfigInvalid')}` : ''}
            {!trusted && trust?.config?.blocked ? ' · workspace config blocked' : ''}
          </div>
          {trust?.effective && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(trust.effective).map(([name, enabled]) => (
                <span key={name} className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${enabled ? 'border-success/30 text-success' : 'border-ink-fade/40 text-ink-fade line-through'}`}>{name}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => controller.changeWorkspaceTrust(trustPath, !trusted, trustScope)}
        disabled={busy || !grant.available}
        className={`h-8 shrink-0 rounded-md border px-3 text-xs transition-colors disabled:opacity-50 ${trusted ? 'border-ink-fade/60 text-ink-soft hover:text-ink' : 'border-success/40 text-success hover:bg-success/5'}`}
      >
        {busy ? t('localFiles.workspaceTrustWorking') : trusted ? t('localFiles.workspaceUntrustAction') : t('localFiles.workspaceTrustAction')}
      </button>
    </div>
  )
}
