import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { isIntegrationEnabled } from '../services/integrationsStore.js'
import { assertBrowserAppUrlAccess, assertBrowserSessionAppAccess, listConnectedBrowserApps } from '../services/connectorService.js'
import { executeBrowserTool } from '../services/browserToolExecutor.js'
import {
  browserConsole,
  browserOpenUrl,
  browserScreenshot,
  browserState,
  closeBrowserSession,
} from '../adapters/browserAutomation.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function sendBrowserError(res, status, code, message, retryable = false) {
  return sendJson(res, status, {
    ok: false,
    error: { code, message, retryable },
  })
}

export async function handleBrowserRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendBrowserError(res, 401, 'AUTH_REQUIRED', '请先登录')
  if (!isIntegrationEnabled({ userId, provider: 'browser', defaultEnabled: true })) {
    return sendBrowserError(res, 403, 'BROWSER_DISABLED', 'Browser is disabled in Access')
  }
  const pathname = new URL(req.url, 'http://localhost').pathname
  try {
    if (req.method === 'GET' && pathname === '/api/browser/state') {
      return sendJson(res, 200, { ok: true, state: await browserState({ userId }) })
    }
    if (req.method === 'POST' && pathname === '/api/browser/state') {
      return sendJson(res, 200, { ok: true, result: await assertBrowserSessionAppAccess({ userId }) })
    }
    if (req.method === 'POST' && pathname === '/api/browser/close') {
      return sendJson(res, 200, { ok: true, closed: closeBrowserSession(userId) })
    }
    if (req.method !== 'POST') {
      return sendBrowserError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST')
    }
    const body = await readJson(req)
    if (pathname === '/api/browser/open' || pathname === '/api/browser/navigate') {
      const connectedApp = assertBrowserAppUrlAccess({ userId, url: body.url })
      const persistent = !!connectedApp || listConnectedBrowserApps({ userId }).length > 0
      return sendJson(res, 200, { ok: true, result: await browserOpenUrl({ userId, url: body.url, headed: persistent }) })
    }
    await assertBrowserSessionAppAccess({ userId })
    if (pathname === '/api/browser/tabs') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_tabs', body, { userId }),
      })
    }
    if (pathname === '/api/browser/switch-tab') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_switch_tab', body, { userId }),
      })
    }
    if (pathname === '/api/browser/frames') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_frames', body, { userId }),
      })
    }
    if (pathname === '/api/browser/switch-frame') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_switch_frame', body, { userId }),
      })
    }
    if (pathname === '/api/browser/snapshot') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_snapshot', body, { userId }),
      })
    }
    if (pathname === '/api/browser/console') return sendJson(res, 200, { ok: true, result: await browserConsole({ userId, clear: body.clear }) })
    if (pathname === '/api/browser/click') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_click', body, { userId }),
      })
    }
    if (pathname === '/api/browser/type') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_type', body, { userId }),
      })
    }
    if (pathname === '/api/browser/upload-file') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_upload_file', body, { userId }),
      })
    }
    if (pathname === '/api/browser/download') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_download', body, { userId }),
      })
    }
    if (pathname === '/api/browser/select') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_select', body, { userId }),
      })
    }
    if (pathname === '/api/browser/press') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_press', body, { userId }),
      })
    }
    if (pathname === '/api/browser/wait') {
      return sendJson(res, 200, {
        ok: true,
        result: await executeBrowserTool('browser_wait', body, { userId }),
      })
    }
    if (pathname === '/api/browser/screenshot') return sendJson(res, 200, { ok: true, result: await browserScreenshot({ userId, fullPage: body.fullPage }) })
    return sendBrowserError(res, 404, 'BROWSER_ROUTE_NOT_FOUND', '未知 Browser 路由')
  } catch (error) {
    const status = error?.statusCode || 400
    return sendBrowserError(
      res,
      status,
      String(error?.code || 'BROWSER_REQUEST_FAILED'),
      error?.message || String(error),
      error?.retryable ?? status >= 500,
    )
  }
}
