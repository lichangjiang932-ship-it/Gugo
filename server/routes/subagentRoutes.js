import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { getSubagentRun, listSubagentTypes, runSubagent } from '../services/subagentRuntime.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export async function handleSubagentRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })

  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/subagent/types') {
      return sendJson(res, 200, { ok: true, types: listSubagentTypes() })
    }

    if (req.method === 'POST' && pathname === '/api/subagent/run') {
      const body = await readJson(req)
      const wantsStream = body.stream === true || String(req.headers.accept || '').includes('text/event-stream')
      if (wantsStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        writeSse(res, { type: 'start', description: body.description || '' })
        try {
          const run = await runSubagent({
            userId,
            type: body.subagent_type || body.type || 'general',
            prompt: body.prompt,
            description: body.description || '',
            agentId: body.agentId || body.agent_id || null,
            skillIds: body.skillIds || body.skill_ids || [],
            parentSessionId: body.parentSessionId || null,
            parentMessageId: body.parentMessageId || null,
            modelName: body.modelName,
          })
          writeSse(res, { type: 'done', run })
        } catch (err) {
          writeSse(res, { type: 'error', error: err?.message || String(err), run: err?.run || null })
        } finally {
          res.end()
        }
        return
      }

      const run = await runSubagent({
        userId,
        type: body.subagent_type || body.type || 'general',
        prompt: body.prompt,
        description: body.description || '',
        agentId: body.agentId || body.agent_id || null,
        skillIds: body.skillIds || body.skill_ids || [],
        parentSessionId: body.parentSessionId || null,
        parentMessageId: body.parentMessageId || null,
        modelName: body.modelName,
      })
      return sendJson(res, 200, { ok: true, run, result_text: run.resultText })
    }

    const runMatch = pathname.match(/^\/api\/subagent\/runs\/([^/]+)(?:\/cancel)?$/)
    if (runMatch) {
      const id = runMatch[1]
      if (req.method === 'GET') {
        const run = getSubagentRun({ userId, id })
        if (!run) return sendJson(res, 404, { ok: false, error: 'run not found' })
        return sendJson(res, 200, { ok: true, run })
      }
      if (req.method === 'POST' && pathname.endsWith('/cancel')) {
        // v1 subagents are short-lived request-scoped tasks. Cancellation is exposed
        // for API compatibility; active abort controllers can be added without UI churn.
        return sendJson(res, 200, { ok: true, cancelled: false, reason: 'run-level cancellation is not active in v1' })
      }
    }

    return sendJson(res, 404, { ok: false, error: 'unknown subagent route' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err), run: err?.run || null })
  }
}
