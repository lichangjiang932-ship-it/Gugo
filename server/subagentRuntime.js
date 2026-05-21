import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { callBackgroundModel } from './modelProxy.js'

const MAX_CONCURRENT_PER_USER = 3
const activeByUser = new Map()

export const SUBAGENT_TYPES = {
  explore: {
    label: 'Explore',
    system: 'You are an isolated explore sub-agent. Read the task, investigate carefully, and return concise findings with concrete file paths, commands, risks, and next actions. Do not claim to edit files.',
  },
  plan: {
    label: 'Plan',
    system: 'You are an isolated planning sub-agent. Produce a practical implementation plan with acceptance checks. Stay read-only and avoid write instructions unless asked by the parent.',
  },
  general: {
    label: 'General',
    system: 'You are an isolated general sub-agent. Complete the focused sub-task and return the final answer only; keep it compact and actionable.',
  },
}

function now() {
  return Date.now()
}

function toRun(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    parentSessionId: row.parent_session_id,
    parentMessageId: row.parent_message_id,
    agentType: row.agent_type,
    prompt: row.prompt,
    status: row.status,
    resultText: row.result_text || '',
    trace: row.trace_json ? JSON.parse(row.trace_json) : [],
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    credits: row.credits,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function insertRun({ id, userId, type, prompt, parentSessionId = null, parentMessageId = null, trace = [] }) {
  const db = getDb()
  db.prepare(
    `INSERT INTO subagent_runs (id, user_id, parent_session_id, parent_message_id, agent_type, prompt, status, trace_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(id, userId, parentSessionId, parentMessageId, type, prompt, JSON.stringify(trace), now())
}

function updateRun({ id, userId, status, resultText = '', trace = [] }) {
  const db = getDb()
  db.prepare(
    `UPDATE subagent_runs SET status = ?, result_text = ?, trace_json = ?, finished_at = ? WHERE id = ? AND user_id = ?`
  ).run(status, resultText, JSON.stringify(trace), now(), id, userId)
  return getSubagentRun({ userId, id })
}

export function getSubagentRun({ userId, id }) {
  const row = getDb().prepare('SELECT * FROM subagent_runs WHERE user_id = ? AND id = ?').get(userId, id)
  return toRun(row)
}

export function listSubagentTypes() {
  return Object.entries(SUBAGENT_TYPES).map(([id, info]) => ({ id, label: info.label }))
}

export async function runSubagent({
  userId,
  type = 'general',
  prompt,
  description = '',
  parentSessionId = null,
  parentMessageId = null,
  modelName,
  signal,
} = {}) {
  if (!userId) throw new Error('userId is required')
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
  if (!SUBAGENT_TYPES[type]) throw new Error(`unknown subagent type: ${type}`)

  const active = activeByUser.get(userId) || 0
  if (active >= MAX_CONCURRENT_PER_USER) {
    const err = new Error('too many concurrent subagents')
    err.statusCode = 429
    throw err
  }
  activeByUser.set(userId, active + 1)

  const id = `subagent-${randomUUID()}`
  const trace = [{ type: 'start', description, at: now() }]
  insertRun({ id, userId, type, prompt, parentSessionId, parentMessageId, trace })

  try {
    const resultText = await callBackgroundModel({
      modelName,
      signal,
      messages: [
        { role: 'system', content: SUBAGENT_TYPES[type].system },
        { role: 'user', content: String(prompt).trim() },
      ],
    })
    trace.push({ type: 'done', at: now() })
    return updateRun({ id, userId, status: 'completed', resultText, trace })
  } catch (err) {
    trace.push({ type: 'error', error: err?.message || String(err), at: now() })
    const run = updateRun({ id, userId, status: 'failed', resultText: err?.message || String(err), trace })
    throw Object.assign(err, { run })
  } finally {
    const next = Math.max(0, (activeByUser.get(userId) || 1) - 1)
    if (next) activeByUser.set(userId, next)
    else activeByUser.delete(userId)
  }
}
