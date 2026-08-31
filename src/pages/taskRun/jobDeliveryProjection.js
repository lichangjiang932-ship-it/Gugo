const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const DELIVERY_FIELDS = [
  'complete',
  'summary',
  'text',
  'reason',
  'incompleteReason',
  'missingRequirements',
  'taskVerification',
  'verifiedLocalFiles',
  'retainedLocalFiles',
  'artifactIds',
  'completedDeliverables',
  'missingDeliverables',
  'issues',
  'acceptance',
  'evidence',
  'nextAction',
]
const MERGED_DIAGNOSTIC_LIST_FIELDS = new Set([
  'missingRequirements',
  'verifiedLocalFiles',
  'retainedLocalFiles',
])
const COMPLETED_VERIFICATION_CHECK_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])

export function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function hasDeliveryFields(value) {
  const output = record(value)
  return !!output && DELIVERY_FIELDS.some((field) => Object.hasOwn(output, field))
}

function selectDeliveryFields(value) {
  const source = record(value)
  if (!source) return null
  const selected = {}
  for (const field of DELIVERY_FIELDS) {
    if (Object.hasOwn(source, field)) selected[field] = source[field]
  }
  return Object.keys(selected).length > 0 ? selected : null
}

function hasMeaningfulDeliveryValue(value) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function diagnosticValueKey(value) {
  if (typeof value === 'string') return `text:${value.trim()}`
  if (record(value)) {
    const id = String(value.id || '').trim()
    if (id) return `id:${id}`
    try { return `object:${JSON.stringify(value)}` } catch { return `object:${String(value)}` }
  }
  return `${typeof value}:${String(value)}`
}

function mergeDiagnosticLists(current, incoming) {
  const merged = []
  const seen = new Set()
  for (const value of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const key = diagnosticValueKey(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(value)
  }
  return merged
}

function mergeTaskVerification(current, incoming) {
  const previous = record(current) || {}
  const next = record(incoming)
  if (!next) return Object.keys(previous).length > 0 ? previous : null
  const merged = { ...previous, ...next }
  for (const field of ['checks', 'issues', 'missingRequirements']) {
    const values = mergeDiagnosticLists(previous[field], next[field])
    if (values.length > 0) merged[field] = values
  }
  return merged
}

function mergeDeliverySources(sources, authoritativeSource = null) {
  const merged = {}
  for (const source of sources) {
    const authoritative = source === authoritativeSource
    for (const [field, value] of Object.entries(source)) {
      if (authoritative) {
        if (MERGED_DIAGNOSTIC_LIST_FIELDS.has(field) && Array.isArray(value)) {
          merged[field] = mergeDiagnosticLists([], value)
          continue
        }
        if (field === 'taskVerification') {
          if (record(value)) merged.taskVerification = { ...value }
          else delete merged.taskVerification
          continue
        }
        if (!hasMeaningfulDeliveryValue(value)) {
          delete merged[field]
          continue
        }
      }
      if (!hasMeaningfulDeliveryValue(value)) continue
      if (field === 'complete' && typeof value === 'boolean') {
        merged.complete = value
        continue
      }
      if (MERGED_DIAGNOSTIC_LIST_FIELDS.has(field) && Array.isArray(value)) {
        merged[field] = mergeDiagnosticLists(merged[field], value)
        continue
      }
      if (field === 'taskVerification' && record(value)) {
        merged.taskVerification = mergeTaskVerification(merged.taskVerification, value)
        continue
      }
      merged[field] = value
    }
  }
  return Object.keys(merged).length > 0 ? merged : null
}

export function resolveCanonicalJobDelivery(job) {
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return null
  const steps = Array.isArray(job.steps) ? job.steps : []
  const events = Array.isArray(job.events) ? job.events : []
  const persistedStatus = TERMINAL_JOB_STATUSES.has(job.persistedStatus)
    ? job.persistedStatus
    : job.status
  const finalOutput = record([...steps].reverse().find((step) => (
    step?.kind === 'finalize' && hasDeliveryFields(step.output)
  ))?.output)
  const terminalPayload = record([...events].reverse().find((event) => (
    event?.type === persistedStatus && hasDeliveryFields(event.payload)
  ))?.payload)
  const projectedDelivery = selectDeliveryFields(job)
  const diagnosticOutputs = steps
    .filter((step) => hasDeliveryFields(step?.output))
    .map((step) => record(step.output))
    .filter(Boolean)
  // Step outputs are chronological evidence; the terminal event is the newest
  // authoritative projection and must not be overwritten by a stale finalize
  // payload. Its explicit empty diagnostic lists clear evidence from an older
  // attempt, while omitted fields still fall back to durable step output.
  const sources = [
    ...diagnosticOutputs,
    finalOutput,
    terminalPayload,
    projectedDelivery,
  ].filter(Boolean)
  return mergeDeliverySources(sources, projectedDelivery || terminalPayload || finalOutput)
}

export function normalizedList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

function localFileReceiptKey(value) {
  if (typeof value === 'string') return value.trim() ? `file:${value.trim()}` : ''
  if (!record(value)) return ''
  const id = String(value.id || '').trim()
  if (id) return `id:${id}`
  const fallback = String(value.path || value.filename || '').trim()
  return fallback ? `file:${fallback}` : ''
}

export function unresolvedRetainedLocalFiles(delivery) {
  const verifiedKeys = new Set((Array.isArray(delivery?.verifiedLocalFiles) ? delivery.verifiedLocalFiles : [])
    .map(localFileReceiptKey)
    .filter(Boolean))
  return (Array.isArray(delivery?.retainedLocalFiles) ? delivery.retainedLocalFiles : [])
    .filter((value) => {
      const key = localFileReceiptKey(value)
      return !key || !verifiedKeys.has(key)
    })
}

function taskVerificationCheckIssue(check) {
  if (!record(check)) return ''
  const status = String(check.status || 'failed').trim().toLowerCase()
  if (COMPLETED_VERIFICATION_CHECK_STATUSES.has(status)) return ''
  const kind = String(check.kind || 'check').trim()
  const code = String(check.code || '').trim()
  const command = String(check.commandScope || '').trim()
  const cwd = String(check.cwd || '').trim()
  const diagnostic = String(check.diagnostic || '').trim()
  const scope = [command, cwd].filter(Boolean).join(' @ ')
  return `${status} ${kind}${code ? ` [${code}]` : ''}`
    + `${scope ? ` (${scope})` : ''}`
    + `${diagnostic ? `: ${diagnostic}` : ''}`
}

export function taskVerificationIssues(value) {
  const verification = record(value)
  if (!verification) return []
  return normalizedList([
    ...(Array.isArray(verification.issues) ? verification.issues : []),
    verification.reason,
    ...(Array.isArray(verification.checks)
      ? verification.checks.map(taskVerificationCheckIssue)
      : []),
  ])
}

export function isIncompleteJobDelivery(delivery, jobStatus) {
  if (!record(delivery)) return jobStatus !== 'completed'
  return jobStatus !== 'completed'
    || delivery.complete === false
    || normalizedList(delivery.missingDeliverables).length > 0
    || normalizedList(delivery.missingRequirements).length > 0
    || normalizedList(delivery.issues).length > 0
    || taskVerificationIssues(delivery.taskVerification).length > 0
    || unresolvedRetainedLocalFiles(delivery).length > 0
    || !!String(delivery.incompleteReason || delivery.reason || '').trim()
}
