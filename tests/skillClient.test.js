import assert from 'node:assert/strict'
import test from 'node:test'
import { importSkillPack, listSkills } from '../src/lib/skillClient.js'

test('skill client uses list and import endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ skills: [], skill: { id: 'writer' } }),
    }
  }

  await listSkills({ fetchImpl })
  await importSkillPack({ 'skill.json': '{}' }, { fetchImpl })

  assert.deepEqual(calls.map((call) => call.url), ['/api/skills', '/api/skills/import'])
})

