import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_SKILLS_KEY,
  listLocalSkills,
  mergeRuntimeSkills,
  saveLocalSkills,
} from '../src/lib/localSkills.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

test('local custom skills persist executable instructions', () => {
  const storage = memoryStorage()
  saveLocalSkills([{
    id: 'review-helper',
    name: '审查助手',
    desc: '审查代码风险',
    systemPrompt: '先检查安全风险，再给出结论。',
    perms: ['代码分析'],
  }], storage)

  const loaded = listLocalSkills(storage)
  assert.equal(loaded[0].systemPrompt, '先检查安全风险，再给出结论。')
  assert.equal(loaded[0].localCustom, true)
  assert.ok(storage.getItem(LOCAL_SKILLS_KEY))
})

test('legacy custom skills gain a useful fallback prompt', () => {
  const storage = memoryStorage()
  storage.setItem(LOCAL_SKILLS_KEY, JSON.stringify([{ id: 'legacy', name: '旧技能', desc: '整理文本' }]))
  assert.match(listLocalSkills(storage)[0].systemPrompt, /整理文本/)
})

test('runtime skill merge keeps local overrides unique', () => {
  const merged = mergeRuntimeSkills(
    [{ id: 'writer', systemPrompt: 'local' }],
    [{ id: 'writer', systemPrompt: 'remote' }, { id: 'ppt' }],
  )
  assert.deepEqual(merged.map((skill) => skill.id), ['writer', 'ppt'])
  assert.equal(merged[0].systemPrompt, 'local')
})
