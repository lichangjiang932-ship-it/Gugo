import { resolveAuthMode } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
import { readBrowserRuntimeConfig } from '../services/runtimeConfigFileService.js'
import {
  clearAuthoritativeUserData,
  createAuthoritativeUserDataArchive,
  previewAuthoritativeUserDataClear,
} from '../services/userDataGovernanceService.js'
import { toPublicRuntimeConfigHttpError } from '../utils/runtimeConfigErrors.js'
import { readJson } from '../utils.js'

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase()
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function contentDisposition(filename) {
  const safe = String(filename || 'runtime.json')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80) || 'runtime.json'
  return `inline; filename="${safe}"`
}

export async function handleRuntimeConfigRequest(
  req,
  res,
  { cwd = process.cwd(), env = process.env } = {},
) {
  const userId = authenticateRequest(req)
  if (!userId) {
    return sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })
  }

  if (resolveAuthMode(env) !== 'local' || !isLoopbackRequest(req)) {
    return sendJson(res, 403, {
      ok: false,
      error: {
        code: 'LOCAL_CONFIG_ONLY',
        message: '运行配置只能从服务宿主机的本机模式打开',
      },
    })
  }

  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/api/system/user-data/export') {
    try {
      const archive = createAuthoritativeUserDataArchive({ userId, env })
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${archive.filename}"`,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      })
      archive.stream.once('error', (error) => {
        if (!res.destroyed) res.destroy(error)
      })
      const abortExport = () => {
        try {
          archive.dispose()
        } catch (error) {
          if (!res.destroyed) res.destroy(error)
        }
      }
      req.once('aborted', abortExport)
      res.once('close', () => {
        if (!res.writableEnded) abortExport()
      })
      archive.stream.pipe(res)
      return
    } catch (error) {
      return sendJson(res, error?.statusCode || 500, {
        ok: false,
        error: {
          code: error?.code || 'USER_DATA_EXPORT_FAILED',
          message: error?.message || 'Unable to export user data',
        },
      })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/system/user-data/preview') {
    try {
      return sendJson(
        res,
        200,
        previewAuthoritativeUserDataClear({ userId, env }),
        { 'Cache-Control': 'private, no-store', Pragma: 'no-cache' },
      )
    } catch (error) {
      return sendJson(res, error?.statusCode || 500, {
        ok: false,
        error: {
          code: error?.code || 'USER_DATA_CLEAR_PREVIEW_FAILED',
          message: error?.message || 'Unable to preview user-data clearing',
        },
      })
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/system/user-data') {
    try {
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      return sendJson(res, 200, clearAuthoritativeUserData({
        userId,
        confirmation: body.confirmation,
        previewToken: body.previewToken,
        requirePreview: true,
        env,
      }))
    } catch (error) {
      const details = Object.fromEntries(
        ['incomplete', 'databaseCleared', 'cleanupPending']
          .filter((name) => typeof error?.[name] === 'boolean')
          .map((name) => [name, error[name]]),
      )
      if (Array.isArray(error?.blockers)) details.blockers = error.blockers
      if (error?.walCheckpoint && typeof error.walCheckpoint === 'object') {
        details.walCheckpoint = error.walCheckpoint
      }
      return sendJson(res, error?.statusCode || 500, {
        ok: false,
        error: {
          code: error?.code || 'USER_DATA_CLEAR_FAILED',
          message: error?.message || 'Unable to clear user data',
          ...details,
        },
      })
    }
  }

  if (!['GET', 'HEAD'].includes(req.method) || url.pathname !== '/api/system/runtime-config') {
    return sendJson(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
    })
  }

  try {
    const config = readBrowserRuntimeConfig({ cwd, env })
    const body = Buffer.from(config.content, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': contentDisposition(config.filename),
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') return res.end()
    return res.end(body)
  } catch (error) {
    const publicError = toPublicRuntimeConfigHttpError(error)
    if (publicError) {
      return sendJson(res, publicError.statusCode, publicError.body)
    }
    const statusCode = error?.statusCode || 500
    return sendJson(res, statusCode, {
      ok: false,
      error: {
        code: error?.code || 'RUNTIME_CONFIG_OPEN_FAILED',
        message: statusCode >= 500
          ? '无法打开运行配置'
          : error?.message || '无法打开运行配置',
      },
    })
  }
}
