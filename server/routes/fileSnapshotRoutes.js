import { authenticateRequest } from '../middleware.js'
import { listSnapshots, rewindFromToolCall, restoreSnapshot } from '../services/fileSnapshotStore.js'
import { readJson } from '../utils.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function sendError(res, error) {
  sendJson(res, error?.statusCode || 500, {
    ok: false,
    error: {
      code: error?.code || 'FILE_SNAPSHOT_ERROR',
      message: error?.message || '快照操作失败',
      ...(Number.isInteger(error?.partialCount) ? {
        details: {
          partialCount: error.partialCount,
          partialRewind: Array.isArray(error.partialRewind) ? error.partialRewind : [],
          ...(error?.recoveryPath ? { recoveryPath: error.recoveryPath } : {}),
        },
      } : {}),
    },
  })
}

export async function handleFileSnapshotRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  }
  const url = new URL(req.url, 'http://localhost')

  try {
    if (req.method === 'GET' && url.pathname === '/api/snapshots') {
      const sessionId = String(url.searchParams.get('sessionId') || '').trim()
      const turnId = String(url.searchParams.get('turnId') || '').trim()
      if (!sessionId || !turnId) {
        return sendJson(res, 400, { ok: false, error: { code: 'TARGET_REQUIRED', message: 'sessionId 与 turnId 必填' } })
      }
      const snapshots = listSnapshots({ userId, sessionId, turnId })
      return sendJson(res, 200, { ok: true, snapshots })
    }

    if (req.method === 'POST' && url.pathname === '/api/snapshots/rewind') {
      const body = await readJson(req)
      const sessionId = String(body?.sessionId || '').trim()
      const turnId = String(body?.turnId || '').trim()
      const toolCallId = String(body?.toolCallId || '').trim()
      if (!sessionId || !turnId || !toolCallId) {
        return sendJson(res, 400, { ok: false, error: { code: 'TARGET_REQUIRED', message: 'sessionId、turnId 与 toolCallId 必填' } })
      }
      const result = rewindFromToolCall({ userId, sessionId, turnId, toolCallId })
      return sendJson(res, 200, { ok: true, ...result })
    }

    if (req.method === 'POST' && url.pathname === '/api/snapshots/restore') {
      const body = await readJson(req)
      const id = String(body?.id || '').trim()
      if (!id) {
        return sendJson(res, 400, { ok: false, error: { code: 'ID_REQUIRED', message: 'id 必填' } })
      }
      const result = restoreSnapshot({ userId, id })
      if (!result) return sendJson(res, 404, { ok: false, error: { code: 'SNAPSHOT_NOT_FOUND', message: '快照不存在' } })
      return sendJson(res, 200, { ok: true, ...result })
    }

    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知快照端点' } })
  } catch (error) {
    sendError(res, error)
  }
}
