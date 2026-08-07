export const FILTER_KEYS = ['all', 'active', 'queued', 'completed', 'failed', 'cancelled']
export const STATUS_KEYS = new Set(['queued', 'planning', 'running', 'waiting', 'awaiting_approval', 'completed', 'failed', 'cancel_requested', 'cancelled'])
export const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'waiting', 'awaiting_approval', 'cancel_requested'])

export function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '—'
}

export function filterJob(job, filter) {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_STATUSES.has(job.status)
  return job.status === filter
}

export function stepAcceptance(step) {
  const acceptance = step?.input?.acceptance
  if (Array.isArray(acceptance)) return acceptance.filter(Boolean)
  return typeof acceptance === 'string' && acceptance.trim() ? [acceptance.trim()] : []
}
