import { AlertTriangle, Check, ShieldAlert, X } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { toolCallLabel } from '../lib/toolCallPresentation.js'
import ActionButton from './ui/ActionButton.jsx'

/** A non-actionable decision receipt. Tool results remain in the execution timeline. */
export default function ApprovalDecisionNotice({ notice, onDismiss }) {
  const { t } = useT()
  if (!notice) return null
  const confirmedAllow = notice.state === 'resolved' && ['approved', 'edited'].includes(notice.outcome)
  const tone = notice.state === 'error' ? 'border-danger/30 bg-danger/5 text-danger'
    : notice.state === 'unknown' ? 'border-warning/30 bg-warning/5 text-warning'
      : confirmedAllow ? 'border-success/20 bg-success/5 text-success' : 'border-ink/20 bg-paper-2 text-ink-soft'
  const Icon = notice.state === 'error' ? AlertTriangle : notice.state === 'unknown' ? ShieldAlert : confirmedAllow ? Check : X
  return <section className={'flex min-w-0 items-start gap-2.5 rounded-control border border-l-2 px-3 py-2.5 ' + tone}
    role={notice.state === 'error' ? 'alert' : 'status'} aria-live="polite" data-testid="approval-decision-notice"
    data-decision-state={notice.state} data-decision-outcome={notice.outcome}>
    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap gap-x-2 text-xs font-medium"><span>{t('toolApproval.decisionTitle')}</span>
        {notice.toolName && <span className="truncate">{toolCallLabel(notice.toolName, t)}</span>}</div>
      <p className="mt-0.5 break-words text-sm">{t(notice.messageKey)}</p>
      <p className="mt-1 text-xs text-ink-soft">{t(notice.state === 'resolved' ? 'toolApproval.decisionNotExecution' : 'toolApproval.decisionCheckBeforeRetry')}</p>
    </div>
    {typeof onDismiss === 'function' && <ActionButton variant="ghost" size="sm" onClick={onDismiss}
      aria-label={t('toolApproval.decisionDismiss')}><X className="h-3.5 w-3.5" aria-hidden="true" /></ActionButton>}
  </section>
}
