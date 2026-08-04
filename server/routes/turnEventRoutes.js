import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { getTurnEngine, TurnEngineError } from '../services/TurnEngine.js'
import { listTurnEvents, subscribeTurnEvents } from '../services/turnEventStore.js'

const TERMINAL_EVENTS = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])

function sendSse(res, event, data, id = null) {
  if (id !== null) res.write(`id: ${id}\n`)
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function parseAfter(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : -1
}

function routeParts(pathname) {
  return pathname.split('/').filter(Boolean)
}

function sendError(res, error) {
  const status = error instanceof TurnEngineError ? error.status : 400
  return sendJson(res, status, {
    error: {
      code: error?.code || 'INVALID_TURN_REQUEST',
      message: error?.message || String(error),
    },
  })
}

export async function handleTurnEventRequest(req, res, engine = getTurnEngine()) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
  const url = new URL(req.url, 'http://localhost')
  const parts = routeParts(url.pathname)
  try {
    if (req.method === 'GET' && url.pathname === '/api/turns/stream') {
      const sessionId = url.searchParams.get('sessionId')
      const turnId = url.searchParams.get('turnId')
      if (!sessionId || !turnId) {
        return sendJson(res, 400, { error: { code: 'TURN_STREAM_TARGET_REQUIRED', message: 'sessionId and turnId are required' } })
      }

      let lastSequence = parseAfter(url.searchParams.get('after'))
      let replaying = true
      let closed = false
      const pending = []
      let heartbeat = null
      let unsubscribe = () => {}
      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
      }
      const sendEvent = (event) => {
        if (closed || event.sequence <= lastSequence) return
        lastSequence = event.sequence
        sendSse(res, 'turn_event', event, event.sequence)
        if (TERMINAL_EVENTS.has(event.type)) {
          cleanup()
          res.end()
        }
      }

      unsubscribe = subscribeTurnEvents({ userId, sessionId, turnId }, (event) => {
        if (replaying) pending.push(event)
        else sendEvent(event)
      })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders?.()
      res.write('retry: 1000\n\n')
      sendSse(res, 'ready', { phase: 'connecting', after: lastSequence })

      const replay = listTurnEvents({ userId, sessionId, turnId, after: lastSequence, limit: 2000 })
      for (const event of replay) sendEvent(event)
      replaying = false
      pending.sort((a, b) => a.sequence - b.sequence).forEach(sendEvent)
      if (!closed) {
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
        }, 15_000)
        heartbeat.unref?.()
        req.on('close', cleanup)
        res.on?.('close', cleanup)
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/turns/events') {
      const events = listTurnEvents({
        userId,
        sessionId: url.searchParams.get('sessionId'),
        turnId: url.searchParams.get('turnId'),
        after: url.searchParams.get('after'),
        limit: url.searchParams.get('limit'),
      })
      return sendJson(res, 200, { events })
    }

    if (req.method === 'POST' && url.pathname === '/api/turns/run') {
      const body = await readJson(req)
      const turn = await engine.startTurn({
        userId,
        sessionId: body.sessionId,
        turnId: body.turnId || undefined,
        content: body.content,
        modelName: body.modelName || null,
        history: body.history,
      })
      return sendJson(res, 202, { turn })
    }

    if (parts[0] === 'api' && parts[1] === 'turns' && parts[2] && parts.length >= 3) {
      const turnId = decodeURIComponent(parts[2])
      if (req.method === 'GET' && parts.length === 3) {
        const turn = engine.getTurn({ userId, sessionId: url.searchParams.get('sessionId'), turnId })
        return turn
          ? sendJson(res, 200, { turn })
          : sendJson(res, 404, { error: { code: 'TURN_NOT_FOUND', message: 'turn not found' } })
      }
      if (req.method === 'POST' && (parts[3] === 'cancel' || parts[3] === 'resume')) {
        const body = await readJson(req)
        const action = parts[3] === 'cancel' ? 'cancelTurn' : 'resumeTurn'
        const turn = await engine[action]({ userId, sessionId: body.sessionId, turnId })
        return sendJson(res, parts[3] === 'resume' ? 202 : 200, { turn })
      }
    }

    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } })
  } catch (error) {
    return sendError(res, error)
  }
}
