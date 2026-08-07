import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { importSkillFromGithubUrl, importSkillPack, listSkills } from '../src/lib/skillClient.js'
import { TOKEN_KEY } from '../src/lib/accountClient.js'

test('skills page exposes folder import flow', () => {
  const toolbarSource = fs.readFileSync(new URL('../src/pages/skillsMarket/SkillsToolbar.jsx', import.meta.url), 'utf8')
  const hookSource = fs.readFileSync(new URL('../src/pages/skillsMarket/useSkillsMarket.js', import.meta.url), 'utf8')
  assert.match(toolbarSource, /webkitdirectory/)
  assert.match(hookSource, /importSkillPack/)
  assert.match(toolbarSource, /skillsMarket\.importPack/)
})

test('all skill API calls include the current authentication token', async () => {
  const previousStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  globalThis.localStorage = { getItem: (key) => key === TOKEN_KEY ? 'test-token' : null }
  globalThis.window = { localStorage: globalThis.localStorage }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ skills: [], skill: { id: 'ok' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await listSkills({ fetchImpl })
    await importSkillPack({ 'skill.json': '{}', 'prompts/system.md': 'test' }, { fetchImpl })
    await importSkillFromGithubUrl('https://github.com/example/skills', { fetchImpl })
    assert.equal(calls.length, 3)
    for (const call of calls) assert.equal(call.init.headers.Authorization, 'Bearer test-token')
  } finally {
    globalThis.localStorage = previousStorage
    globalThis.window = previousWindow
  }
})
