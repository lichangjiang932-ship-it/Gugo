function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

function normalizedId(value) {
  return String(value || '').trim()
}

function normalizedPath(value) {
  return String(value || '').trim().replace(/\\/g, '/')
}

function addRestoredValues(target, values, normalize) {
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalize(value)
    if (normalized) target.add(normalized)
  }
}

/** Restore progress without trusting model-authored counters. */
export function restoreToolProgress(value = {}) {
  const observedCallIds = new Set()
  const completedCallIds = new Set()
  const changedFiles = new Set()
  addRestoredValues(observedCallIds, value.observedCallIds, normalizedId)
  addRestoredValues(completedCallIds, value.completedCallIds, normalizedId)
  addRestoredValues(changedFiles, value.changedFiles, normalizedPath)
  for (const id of completedCallIds) observedCallIds.add(id)
  return {
    observedCallIds,
    completedCallIds,
    changedFiles,
    additions: nonNegativeInteger(value.additions),
    deletions: nonNegativeInteger(value.deletions),
    hasLineStats: value.hasLineStats === true,
  }
}

export function observeToolCalls(progress, calls) {
  for (const call of Array.isArray(calls) ? calls : []) {
    const id = normalizedId(call?.id)
    if (id) progress.observedCallIds.add(id)
  }
  return progress
}

/**
 * Record only executor-derived facts. The caller supplies canonical mutation
 * targets; additions/deletions are accepted only from structured tool output.
 */
export function recordToolProgress(progress, {
  call,
  succeeded = false,
  changedPaths = [],
  changes = [],
} = {}) {
  const id = normalizedId(call?.id)
  const alreadyCompleted = id && progress.completedCallIds.has(id)
  if (id) {
    progress.observedCallIds.add(id)
    progress.completedCallIds.add(id)
  }
  // Checkpoints can replay completed calls after a process restart. Completion
  // and diff counters must remain idempotent even when the same outcome is
  // observed more than once.
  if (alreadyCompleted) return progress
  if (!succeeded) return progress

  for (const value of changedPaths) {
    const file = normalizedPath(value)
    if (file) progress.changedFiles.add(file)
  }
  for (const change of Array.isArray(changes) ? changes : []) {
    const file = normalizedPath(change?.path)
    if (file) progress.changedFiles.add(file)
    const additions = nonNegativeInteger(change?.additions, -1)
    const deletions = nonNegativeInteger(change?.deletions, -1)
    if (additions >= 0 || deletions >= 0) progress.hasLineStats = true
    if (additions >= 0) progress.additions += additions
    if (deletions >= 0) progress.deletions += deletions
  }
  return progress
}

export function toolProgressPayload(progress, { iteration = 0, phase = 'tool_completed' } = {}) {
  const completed = progress.completedCallIds.size
  const total = Math.max(completed, progress.observedCallIds.size)
  return {
    completed,
    total,
    iteration: nonNegativeInteger(iteration),
    filesChanged: progress.changedFiles.size,
    ...(progress.hasLineStats
      ? { additions: progress.additions, deletions: progress.deletions }
      : {}),
    phase: String(phase || 'tool_completed'),
  }
}

export function serializeToolProgress(progress) {
  return {
    observedCallIds: [...progress.observedCallIds],
    completedCallIds: [...progress.completedCallIds],
    changedFiles: [...progress.changedFiles],
    additions: progress.additions,
    deletions: progress.deletions,
    hasLineStats: progress.hasLineStats,
  }
}
