const RUN_COLUMNS = `
  id,
  user_id,
  parent_session_id,
  parent_message_id,
  agent_type,
  prompt,
  model_name,
  model_provider_id,
  model_config_revision,
  status,
  result_text,
  trace_json,
  tokens_in,
  tokens_out,
  created_at,
  finished_at
`

function parseTrace(value) {
  if (!value) return []
  try {
    const trace = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(trace) ? trace : []
  } catch {
    return []
  }
}

function toRunDto(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    parentSessionId: row.parent_session_id,
    parentMessageId: row.parent_message_id,
    agentType: row.agent_type,
    prompt: row.prompt,
    modelName: row.model_name || null,
    modelProviderId: row.model_provider_id || null,
    modelConfigRevision: Number.isInteger(row.model_config_revision)
      ? row.model_config_revision
      : null,
    status: row.status,
    resultText: row.result_text || '',
    trace: parseTrace(row.trace_json),
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function traceJson(trace) {
  return JSON.stringify(Array.isArray(trace) ? trace : [])
}

const SUBAGENT_CHECKPOINT_EVENT = 'runtime_checkpoint'
const TRACE_CAS_MAX_ATTEMPTS = 8

function checkpointAnalysisFromTrace(trace) {
  let checkpoint = null
  let previousSequence = null
  let outOfOrder = false
  let conflictingHighestState = false
  for (const event of trace) {
    if (event?.type !== SUBAGENT_CHECKPOINT_EVENT) continue
    const sequence = event?.state?.checkpointWriteSequence
    if (!Number.isSafeInteger(sequence) || sequence <= 0) continue
    if (previousSequence != null && sequence < previousSequence) outOfOrder = true
    previousSequence = sequence
    if (!checkpoint || sequence > checkpoint.sequence) {
      checkpoint = { sequence, state: event.state }
      conflictingHighestState = false
    } else if (sequence === checkpoint.sequence && !sameJsonValue(event.state, checkpoint.state)) {
      conflictingHighestState = true
    }
  }
  return { checkpoint, outOfOrder, conflictingHighestState }
}

function checkpointRecordFromTrace(trace) {
  return checkpointAnalysisFromTrace(trace).checkpoint
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalJsonValue(value[key])
    return result
  }, {})
}

function sameJsonValue(left, right) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right))
}

function isAppendOnlyTraceExtension(currentTrace, nextTrace) {
  if (nextTrace.length < currentTrace.length) return false
  return currentTrace.every((event, index) => sameJsonValue(event, nextTrace[index]))
}

function publicTrace(trace) {
  return trace.filter((event) => event?.type !== SUBAGENT_CHECKPOINT_EVENT)
}

function validateRequestedCheckpoint(trace, checkpointWriteSequence) {
  const analysis = checkpointAnalysisFromTrace(trace)
  const { checkpoint } = analysis
  if (analysis.outOfOrder) {
    throw Object.assign(new Error('subagent checkpoint trace is not monotonic'), {
      code: 'SUBAGENT_RUN_PERSISTENCE_PORT_STALE_CHECKPOINT',
    })
  }
  if (checkpointWriteSequence != null && checkpoint?.sequence !== checkpointWriteSequence) {
    throw Object.assign(
      new Error('subagent checkpoint write sequence does not match trace'),
      { code: 'SUBAGENT_CHECKPOINT_SEQUENCE_MISMATCH' },
    )
  }
  return {
    checkpoint,
    conflictingHighestState: analysis.conflictingHighestState,
    sequence: checkpointWriteSequence ?? checkpoint?.sequence ?? null,
  }
}

function mayReplaceRunningTrace(currentTrace, nextTrace, requested) {
  if (requested.conflictingHighestState) return false
  const current = checkpointRecordFromTrace(currentTrace)
  if (!current) return true
  if (requested.sequence == null || requested.sequence < current.sequence) return false
  if (requested.sequence > current.sequence) return true
  return sameJsonValue(requested.checkpoint?.state, current.state)
    && isAppendOnlyTraceExtension(publicTrace(currentTrace), publicTrace(nextTrace))
}

function insertSubagentRun(getDb, getRun, {
  id,
  userId,
  parentSessionId = null,
  parentMessageId = null,
  agentType,
  prompt,
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
  trace = [],
  createdAt = Date.now(),
}) {
  getDb().prepare(`
    INSERT INTO subagent_runs (
      id, user_id, parent_session_id, parent_message_id, agent_type, prompt,
      model_name, model_provider_id, model_config_revision, status, trace_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(
    id, userId, parentSessionId, parentMessageId, agentType, prompt,
    modelName, modelProviderId, modelConfigRevision, traceJson(trace), createdAt,
  )
  return getRun({ userId, id })
}

function markSubagentRunRunning(getDb, getRun, {
  userId,
  id,
  trace,
  startedAt = null,
}) {
  const changed = getDb().prepare(`
    UPDATE subagent_runs
    SET status = 'running', trace_json = ?, finished_at = NULL,
        created_at = COALESCE(created_at, ?)
    WHERE id = ? AND user_id = ?
      AND status IN ('interrupted', 'needs_verification')
  `).run(traceJson(trace), startedAt, id, userId).changes
  if (!changed) {
    const current = getRun({ userId, id })
    if (!current) throw new Error('subagent run not found')
    throw Object.assign(new Error('subagent run is not claimable'), {
      code: 'SUBAGENT_RUN_NOT_CLAIMABLE',
      status: current.status,
    })
  }
  return getRun({ userId, id })
}

export function createSqliteSubagentRunPersistenceAdapter({ getDb } = {}) {
  if (typeof getDb !== 'function') {
    throw new TypeError('sqlite subagent run persistence adapter requires getDb')
  }

  const readOwnedRun = ({ userId, id }) => getDb().prepare(`
    SELECT ${RUN_COLUMNS}
    FROM subagent_runs
    WHERE user_id = ? AND id = ?
  `).get(userId, id)

  const getRun = (input) => toRunDto(readOwnedRun(input))

  return Object.freeze({
    apiVersion: 1,
    id: 'builtin.sqlite',

    createRun(input) {
      return insertSubagentRun(getDb, getRun, input)
    },

    getRun,

    markRunning(input) {
      return markSubagentRunRunning(getDb, getRun, input)
    },

    saveRunningTrace({ userId, id, trace, checkpointWriteSequence = null }) {
      const nextTrace = Array.isArray(trace) ? trace : []
      const nextTraceJson = traceJson(nextTrace)
      const requested = validateRequestedCheckpoint(nextTrace, checkpointWriteSequence)
      const db = getDb()
      const compareAndSet = db.prepare(`
        UPDATE subagent_runs
        SET trace_json = ?
        WHERE id = ? AND user_id = ? AND status = 'running' AND trace_json IS ?
      `)

      for (let attempt = 0; attempt < TRACE_CAS_MAX_ATTEMPTS; attempt += 1) {
        const currentRow = readOwnedRun({ userId, id })
        if (!currentRow || currentRow.status !== 'running') {
          throw new Error('subagent run is not running')
        }
        const currentTrace = parseTrace(currentRow.trace_json)
        if (!mayReplaceRunningTrace(currentTrace, nextTrace, requested)) {
          return toRunDto(currentRow)
        }
        const changed = compareAndSet.run(
          nextTraceJson,
          id,
          userId,
          currentRow.trace_json,
        ).changes
        if (changed) return getRun({ userId, id })
      }
      throw Object.assign(new Error('subagent trace compare-and-set did not converge'), {
        code: 'SUBAGENT_TRACE_CAS_CONTENTION',
      })
    },

    finishRun({ userId, id, status, resultText = '', trace = [], finishedAt }) {
      const nextTrace = Array.isArray(trace) ? trace : []
      const nextTraceJson = traceJson(nextTrace)
      const requested = validateRequestedCheckpoint(nextTrace, null)
      const finish = getDb().prepare(`
        UPDATE subagent_runs
        SET status = ?, result_text = ?, trace_json = ?, finished_at = ?
        WHERE id = ? AND user_id = ? AND status = 'running' AND trace_json IS ?
      `)
      for (let attempt = 0; attempt < TRACE_CAS_MAX_ATTEMPTS; attempt += 1) {
        const currentRow = readOwnedRun({ userId, id })
        if (!currentRow || currentRow.status !== 'running') return null
        if (!mayReplaceRunningTrace(parseTrace(currentRow.trace_json), nextTrace, requested)) {
          return null
        }
        const changed = finish.run(
          status,
          resultText,
          nextTraceJson,
          finishedAt,
          id,
          userId,
          currentRow.trace_json,
        ).changes
        if (changed) return getRun({ userId, id })
      }
      throw Object.assign(new Error('subagent finish compare-and-set did not converge'), {
        code: 'SUBAGENT_FINISH_CAS_CONTENTION',
      })
    },

    listRunningRuns() {
      return getDb().prepare(`
        SELECT ${RUN_COLUMNS}
        FROM subagent_runs
        WHERE status = 'running'
      `).all().map(toRunDto)
    },

    interruptRunningRun({ userId, id, status, resultText = '', trace = [], finishedAt }) {
      const nextTrace = Array.isArray(trace) ? trace : []
      const nextTraceJson = traceJson(nextTrace)
      const requested = validateRequestedCheckpoint(nextTrace, null)
      const interrupt = getDb().prepare(`
        UPDATE subagent_runs
        SET status = ?, result_text = ?, trace_json = ?, finished_at = ?
        WHERE id = ? AND user_id = ? AND status = 'running' AND trace_json IS ?
      `)
      for (let attempt = 0; attempt < TRACE_CAS_MAX_ATTEMPTS; attempt += 1) {
        const currentRow = readOwnedRun({ userId, id })
        if (!currentRow || currentRow.status !== 'running') {
          return { userId, id, interrupted: false }
        }
        if (!mayReplaceRunningTrace(parseTrace(currentRow.trace_json), nextTrace, requested)) {
          return { userId, id, interrupted: false }
        }
        const interrupted = interrupt.run(
          status,
          resultText,
          nextTraceJson,
          finishedAt,
          id,
          userId,
          currentRow.trace_json,
        ).changes > 0
        if (interrupted) return { userId, id, interrupted: true }
      }
      throw Object.assign(new Error('subagent interrupt compare-and-set did not converge'), {
        code: 'SUBAGENT_INTERRUPT_CAS_CONTENTION',
      })
    },
  })
}
