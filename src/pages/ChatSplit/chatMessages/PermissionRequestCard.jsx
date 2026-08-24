import { AlertTriangle, LayoutList } from 'lucide-react'

export default function PermissionRequestCard({ request, onAllow, onDeny, onNavigate, t }) {
  if (!request) return null

  return (
    <section
      className="rounded-control border border-ink/10 border-l-2 border-l-warning bg-paper px-3 py-2.5"
      data-testid="permission-approval-card"
      role="region"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm text-ink">{t('chatMessages.permissionRequest', { name: request.skillName })}</span>
            <span className="flex items-center gap-1 font-mono text-xs text-ink-fade">
              <LayoutList className="h-3.5 w-3.5" />
              {t('chatMessages.permissionHandled')}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-soft">
            {(request.perms || []).map((permission, index) => (
              <span key={`${permission.name}-${index}`}>
                <span className="text-warning" aria-hidden="true">●</span>{' '}
                {permission.name} · {permission.detail}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onNavigate} className="h-8 rounded-control px-3 text-xs text-ink-soft transition-colors hover:bg-ink/[0.045] hover:text-ink">{t('chatMessages.refineScope')}</button>
        <button type="button" onClick={onDeny} className="h-8 rounded-control border border-ink/15 px-3 text-xs text-ink-soft transition-colors hover:border-ink/25 hover:text-ink">{t('chatMessages.deny')}</button>
        <button type="button" onClick={onAllow} className="h-8 rounded-control bg-accent px-3 text-xs font-semibold text-accent-contrast transition-colors hover:bg-accent/90">{t('chatMessages.allowContinue')}</button>
      </div>
    </section>
  )
}
