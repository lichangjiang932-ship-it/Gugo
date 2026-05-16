import { installValidatedSkillPack } from './skillImport.js'
import { listRuntimeSkillIds, listRuntimeSkills } from './skillRegistry.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() ? JSON.parse(raw) : {}
}

export async function handleSkillRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return sendJson(res, 200, { skills: listRuntimeSkills() })
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/import') {
    const body = await readJson(req)
    const result = installValidatedSkillPack({
      files: body.files || {},
      existingIds: listRuntimeSkillIds(),
    })
    if (!result.ok) return sendJson(res, 400, { error: result.reason })
    return sendJson(res, 201, { skill: result.skill })
  }

  return sendJson(res, 404, { error: 'not found' })
}

