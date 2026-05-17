import { authenticateRequest } from './middleware.js'
import { installValidatedSkillPack } from './skillImport.js'
import { listRuntimeSkillIds, listRuntimeSkills } from './skillRegistry.js'
import { readJson, sendJson } from './utils.js'

export async function handleSkillRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')

  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: 'Unauthorized' })

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return sendJson(res, 200, { skills: listRuntimeSkills({ userId }) })
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/import') {
    const body = await readJson(req)
    const result = installValidatedSkillPack({
      files: body.files || {},
      existingIds: listRuntimeSkillIds({ userId }),
      userId,
    })
    if (!result.ok) return sendJson(res, 400, { error: result.reason })
    return sendJson(res, 201, { skill: result.skill })
  }

  return sendJson(res, 404, { error: 'not found' })
}
