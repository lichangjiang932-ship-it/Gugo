export function recordKey(record) {
  return JSON.stringify([
    record.scopeKey || record.sessionId || record.jobId || record.scopeKind,
    record.stepId || record.turnId || '',
    record.toolCallId,
  ])
}

export function mergeRecords(current, incoming) {
  const merged = new Map()
  for (const record of [...current, ...incoming]) merged.set(recordKey(record), record)
  return [...merged.values()]
}

function timestampDate(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date : null
}

export function formatTimestamp(value, lang, fallback) {
  const date = timestampDate(value)
  if (!date) return fallback
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

export function timestampDateTime(value) {
  return timestampDate(value)?.toISOString()
}

export function contextLabel(record, t) {
  if (record.jobId) return t('sideEffectRecovery.jobContext', { id: record.jobId })
  if (record.turnId) return t('sideEffectRecovery.turnContext', { id: record.turnId })
  if (record.sessionId) return t('sideEffectRecovery.sessionContext', { id: record.sessionId })
  return t('sideEffectRecovery.scopeContext', { kind: record.scopeKind || 'runtime' })
}

export function verifiedOutputText(output, t) {
  if (!output || typeof output !== 'object') return ''
  return [
    output.target,
    output.artifactId
      ? t('sideEffectRecovery.artifactReference', { id: output.artifactId })
      : '',
    output.receiptId
      ? t('sideEffectRecovery.receiptReference', { id: output.receiptId })
      : '',
    output.sha256
      ? t('sideEffectRecovery.sha256Reference', { digest: output.sha256 })
      : '',
    Number.isFinite(output.size)
      ? t('sideEffectRecovery.sizeReference', { size: output.size })
      : '',
  ].filter(Boolean).join(' · ')
}
