import { verifiedOutputText } from './recoveryUtils.js'

function EvidenceValues({ values }) {
  if (!Array.isArray(values) || values.length === 0) return null
  return (
    <ul className="mt-1 grid gap-1">
      {values.map((value, index) => (
        <li className="break-all font-mono text-xs text-ink-soft" key={`${value}-${index}`}>
          {value}
        </li>
      ))}
    </ul>
  )
}

export default function RecoveryEvidence({ record, t }) {
  const evidence = record.evidence && typeof record.evidence === 'object'
    ? record.evidence
    : {}
  const targetSummary = Array.isArray(evidence.targetSummary) ? evidence.targetSummary : []
  const changedPaths = Array.isArray(evidence.changedPaths) ? evidence.changedPaths : []
  const verifiedOutputs = Array.isArray(evidence.verifiedOutputs)
    ? evidence.verifiedOutputs.map((output) => verifiedOutputText(output, t)).filter(Boolean)
    : []
  const artifactIds = Array.isArray(evidence.artifactIds) ? evidence.artifactIds : []
  const hasEvidence = targetSummary.length > 0
    || changedPaths.length > 0
    || verifiedOutputs.length > 0
    || artifactIds.length > 0

  return (
    <div
      className="mt-3 rounded-md border border-ink/10 bg-ink/[0.025] px-3 py-3"
      data-testid="side-effect-recovery-evidence"
    >
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-ink">{t('sideEffectRecovery.toolCallIdLabel')}</dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink-soft">{record.toolCallId}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">{t('sideEffectRecovery.argsDigestLabel')}</dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink-soft">{record.argsDigest}</dd>
        </div>
        {record.stepId ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.stepIdLabel')}</dt>
            <dd className="mt-1 break-all font-mono text-xs text-ink-soft">{record.stepId}</dd>
          </div>
        ) : null}
        {targetSummary.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.targetSummaryLabel')}</dt>
            <dd><EvidenceValues values={targetSummary} /></dd>
          </div>
        ) : null}
        {changedPaths.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.changedPathsLabel')}</dt>
            <dd><EvidenceValues values={changedPaths} /></dd>
          </div>
        ) : null}
        {verifiedOutputs.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.verifiedOutputsLabel')}</dt>
            <dd><EvidenceValues values={verifiedOutputs} /></dd>
          </div>
        ) : null}
        {artifactIds.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.artifactIdsLabel')}</dt>
            <dd><EvidenceValues values={artifactIds} /></dd>
          </div>
        ) : null}
      </dl>
      {!hasEvidence ? (
        <p className="mt-2 text-xs leading-5 text-ink-fade">{t('sideEffectRecovery.noEvidence')}</p>
      ) : null}
    </div>
  )
}
