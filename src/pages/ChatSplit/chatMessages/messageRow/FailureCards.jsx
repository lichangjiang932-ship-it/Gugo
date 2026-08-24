import { AlertTriangle } from 'lucide-react'
import { stripChoices } from '../../../../lib/choices.js'
import { getVisibleModelErrorMessage } from '../../../../lib/chatFlowGuards.js'

function FailureLine({ action, className = '', detail, testId, title }) {
  return (
    <section
      className={`flex items-start gap-2 border-l-2 border-l-warning/55 py-1.5 pl-3 text-ui text-ink ${className}`}
      data-testid={testId}
      role="alert"
    >
      <AlertTriangle className="mt-1 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1 leading-5">
        <strong className="font-semibold">{title}</strong>
        {detail ? <span className="ml-1 text-ink-soft">{detail}</span> : null}
        {action}
      </div>
    </section>
  )
}

const actionClass = 'ml-2 inline-flex font-medium text-accent-ink underline-offset-4 hover:underline focus-visible:underline'

export function SideEffectRecoveryCard({ modelRequest = false, msg, t }) {
  const recoveryQuery = new URLSearchParams({
    tab: 'recovery',
    turnId: String(msg?.meta?.serverTurnId || ''),
    modelRequestId: String(msg?.meta?.serverRecoveryModelRequestId || ''),
  })
  return <FailureLine
    className="mt-3"
    testId={modelRequest ? 'model-request-recovery-blocked' : 'side-effect-recovery-blocked'}
    title={t(modelRequest ? 'chatMessages.modelRequestUnknownTitle' : 'chatMessages.sideEffectUnknownTitle')}
    detail={t(modelRequest ? 'chatMessages.modelRequestUnknownBody' : 'chatMessages.sideEffectUnknownBody')}
    action={(
      <a
        className={actionClass}
        href={modelRequest ? `#/settings?${recoveryQuery}` : '#/settings?tab=recovery'}
      >
        {t(modelRequest ? 'chatMessages.openModelRequestRecovery' : 'chatMessages.openSideEffectRecovery')}
      </a>
    )}
  />
}

export function ModelSetupFailureCard({ msg, onManageModels, t }) {
  const actionCopy = String(t('errors.modelConfigurationAction') || '').trim()
  const content = String(stripChoices(msg.content) || '').trim()
  const title = String(t('errors.modelConfigurationFailure') || '').trim()
  const fallbackDetail = String(getVisibleModelErrorMessage(msg, t) || '').trim()
  const rawDetail = content || fallbackDetail
  const detail = actionCopy ? rawDetail.replace(actionCopy, '').trim() : rawDetail
  return <FailureLine
    testId="model-setup-error-card"
    title={title}
    detail={detail && detail !== title ? detail : ''}
    action={(
      <button
        type="button"
        className={actionClass}
        data-testid="open-model-settings"
        onClick={onManageModels}
      >
        {t('modelProviders.manage')}
      </button>
    )}
  />
}

export function RuntimeRecoveryCard({ msg, t }) {
  return <FailureLine
    testId="runtime-recovery-error-card"
    title={t('errors.runtimeAttentionRequired')}
    detail={getVisibleModelErrorMessage(msg, t)}
    action={(
      <a
        className={actionClass}
        data-testid="open-runtime-diagnostics"
        href="#/settings?tab=about"
      >
        {t('errors.openRuntimeDiagnostics')}
      </a>
    )}
  />
}
