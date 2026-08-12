import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { isIntegrationEnabled } from '../services/integrationsStore.js'
import { assertBrowserAppUrlAccess, assertBrowserSessionAppAccess, listConnectedBrowserApps } from '../services/connectorService.js'
import {
  browserClick,
  browserConsole,
  browserOpenUrl,
  browserPress,
  browserScreenshot,
  browserSelect,
  browserSnapshot,
  browserState,
  browserType,
  browserWait,
  closeBrowserSession,
} from '../adapters/browserAutomation.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export async function handleBrowserRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: '请先登录' })
  if (!isIntegrationEnabled({ userId, provider: 'browser', defaultEnabled: true })) {
    return sendJson(res, 403, { ok: false, error: 'Browser is disabled in Access' })
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
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    const body = await readJson(req)
    if (pathname === '/api/browser/open' || pathname === '/api/browser/navigate') {
      const connectedApp = assertBrowserAppUrlAccess({ userId, url: body.url })
      const persistent = !!connectedApp || listConnectedBrowserApps({ userId }).length > 0
      return sendJson(res, 200, { ok: true, result: await browserOpenUrl({ userId, url: body.url, headed: persistent }) })
    }
    await assertBrowserSessionAppAccess({ userId })
    if (pathname === '/api/browser/snapshot') return sendJson(res, 200, { ok: true, result: await browserSnapshot({ userId, maxText: body.maxText }) })
    if (pathname === '/api/browser/console') return sendJson(res, 200, { ok: true, result: await browserConsole({ userId, clear: body.clear }) })
    if (pathname === '/api/browser/click') {
      const result = await browserClick({ userId, target: body.target })
      if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
      return sendJson(res, 200, { ok: true, result })
    }
    if (pathname === '/api/browser/type') {
      const result = await browserType({ userId, target: body.target, text: body.text, submit: body.submit })
      await assertBrowserSessionAppAccess({ userId })
      return sendJson(res, 200, { ok: true, result })
    }
    if (pathname === '/api/browser/select') {
      const result = await browserSelect({ userId, target: body.target, value: body.value })
      if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
      return sendJson(res, 200, { ok: true, result })
    }
    if (pathname === '/api/browser/press') {
      const result = await browserPress({ userId, target: body.target, key: body.key })
      if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
      return sendJson(res, 200, { ok: true, result })
    }
    if (pathname === '/api/browser/wait') {
      const result = await browserWait({ userId, ms: body.ms, target: body.target })
      await assertBrowserSessionAppAccess({ userId })
      return sendJson(res, 200, { ok: true, result })
    }
    if (pathname === '/api/browser/screenshot') return sendJson(res, 200, { ok: true, result: await browserScreenshot({ userId, fullPage: body.fullPage }) })
    return sendJson(res, 404, { ok: false, error: '未知 Browser 路由' })
  } catch (error) {
    return sendJson(res, error?.statusCode || 400, { ok: false, error: error?.message || String(error) })
  }
}
