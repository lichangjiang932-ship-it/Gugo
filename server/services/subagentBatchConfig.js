export const DEFAULT_SUBAGENT_MAX_PER_BATCH = 8

export function resolveSubagentMaxPerBatch(env = process.env) {
  const configured = Number(env?.SUBAGENT_MAX_PER_BATCH)
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_SUBAGENT_MAX_PER_BATCH
}

export const SUBAGENT_MAX_PER_BATCH = resolveSubagentMaxPerBatch()
