import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import {
  connectBrowserApp,
  fetchNotionPage,
  getGithubFile,
  listConnectedBrowserApps,
  listQqMailMessages,
  openConnectedBrowserApp,
  readQqMailMessage,
  searchGithubRepositories,
  searchNotion,
  sendQqMailMessage,
} from '../services/connectorService.js'

export async function handleConnectorRequest(req, res, { env = process.env, mailClient } = {}) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
  const pathname = new URL(req.url, 'http://localhost').pathname
  try {
    if (req.method === 'GET' && pathname === '/api/connectors/apps') {
      return sendJson(res, 200, { ok: true, apps: listConnectedBrowserApps({ userId, enabledOnly: false }) })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST' })
    const body = await readJson(req)
    let result
    if (pathname === '/api/connectors/apps/connect') result = await connectBrowserApp({ userId, provider: body.provider })
    else if (pathname === '/api/connectors/apps/open') result = await openConnectedBrowserApp({ userId, provider: body.provider })
    else if (pathname === '/api/connectors/notion/search') result = await searchNotion({ userId, query: body.query })
    else if (pathname === '/api/connectors/notion/page') result = await fetchNotionPage({ userId, pageId: body.pageId })
    else if (pathname === '/api/connectors/github/search-repositories') result = await searchGithubRepositories({ userId, query: body.query })
    else if (pathname === '/api/connectors/github/file') result = await getGithubFile({ userId, ...body })
    else if (pathname === '/api/connectors/qq-mail/messages') result = await listQqMailMessages({ userId, limit: body.limit, env, mailClient })
    else if (pathname === '/api/connectors/qq-mail/message') result = await readQqMailMessage({ userId, uid: body.uid, env, mailClient })
    else if (pathname === '/api/connectors/qq-mail/send') result = await sendQqMailMessage({ userId, ...body, env, mailClient })
    else return sendJson(res, 404, { ok: false, error: 'Unknown connector route' })
    return sendJson(res, 200, { ok: true, result })
  } catch (error) {
    return sendJson(res, error?.statusCode || 400, { ok: false, error: error?.message || String(error) })
  }
}
