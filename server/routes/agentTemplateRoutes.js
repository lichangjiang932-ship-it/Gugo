/**
 * Built-in Yuan/persona templates.
 *
 *   GET /api/agent-templates
 *   GET /api/agent-templates/:id?lang=zh|en
 */

import { sendJson } from '../utils.js'
import { getAgentTemplate, listAgentTemplates } from '../services/agentTemplates.js'

function readLang(url) {
  return url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
}

export async function handleAgentTemplateRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }

  if (url.pathname === '/api/agent-templates') {
    return sendJson(res, 200, {
      ok: true,
      templates: listAgentTemplates({ lang: readLang(url) }),
    })
  }

  const match = url.pathname.match(/^\/api\/agent-templates\/([a-z0-9_-]+)$/i)
  if (match) {
    const template = getAgentTemplate(match[1], { lang: readLang(url) })
    if (!template) return sendJson(res, 404, { ok: false, error: 'template not found' })
    return sendJson(res, 200, { ok: true, template })
  }

  return sendJson(res, 404, { ok: false, error: 'template not found' })
}
