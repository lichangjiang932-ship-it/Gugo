import { authenticateRequest } from '../middleware.js'
import { readJson } from '../utils.js'
import {
  listSideEffectHistory,
  listUnknownSideEffects,
  resolveUnknownSideEffect,
  sideEffectResumeDescriptor,
  sideEffectRecoveryRecordForClient,
} from '../services/sideEffectRecoveryService.js'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
}
const SIDE_EFFECT_RECOVERY_BODY_LIMIT = 8 * 1024

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export async function handleSideEffectRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, {
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })
  }

  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/api/side-effects/unknown') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
        })
      }
      const page = listUnknownSideEffects({
        userId,
        limit: url.searchParams.get('limit'),
        cursor: url.searchParams.get('cursor'),
      })
      return sendJson(res, 200, page)
    }

    if (url.pathname === '/api/side-effects/history') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
        })
      }
      const page = listSideEffectHistory({
        userId,
        limit: url.searchParams.get('limit'),
        cursor: url.searchParams.get('cursor'),
      })
      return sendJson(res, 200, page)
    }

    if (url.pathname === '/api/side-effects/resolve') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
        })
      }
      const body = await readJson(req, { maxBytes: SIDE_EFFECT_RECOVERY_BODY_LIMIT })
      const record = resolveUnknownSideEffect({
        userId,
        scopeKey: body?.scopeKey,
        toolCallId: body?.toolCallId,
        verificationConfirmed: body?.verificationConfirmed,
        confirmToolCallId: body?.confirmToolCallId,
        resolution: body?.resolution,
        note: body?.note,
      })
      return sendJson(res, 200, {
        ok: true,
        record: sideEffectRecoveryRecordForClient(record, { includeScopeKey: false }),
        resume: sideEffectResumeDescriptor(record),
      })
    }

    return sendJson(res, 404, {
      error: { code: 'NOT_FOUND', message: '接口不存在' },
    })
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400
    return sendJson(res, statusCode, {
      error: {
        code: error?.statusCode === 413
          ? 'SIDE_EFFECT_RECOVERY_REQUEST_TOO_LARGE'
          : error?.code || 'SIDE_EFFECT_RECOVERY_INVALID',
        message: statusCode >= 500
          ? '副作用恢复操作失败'
          : error?.message || '副作用恢复请求无效',
      },
    })
  }
}
