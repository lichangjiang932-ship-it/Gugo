import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSlashItems } from '../src/components/slashItems.js'
import { renderPromptTemplate } from '../src/lib/pluginClient.js'

const skills = [
  { id: 'ppt', name: '制作 PPT', desc: 'pp', recommended: true },
  { id: 'doc', name: '整理文档', desc: 'doc' },
]
const templates = [
  { id: 'greeting', name: '问候', description: 'hi' },
  { id: 'ppt-outline', name: 'PPT 大纲', description: '大纲模板' },
]

test('buildSlashItems empty query → skills first, then templates', () => {
  const items = buildSlashItems({ skills, promptTemplates: templates, query: '' })
  assert.equal(items.length, 4)
  assert.equal(items[0].kind, 'skill')
  assert.equal(items[0].id, 'ppt')
  assert.equal(items[2].kind, 'prompt-template')
  assert.equal(items[2].id, 'greeting')
})

test('buildSlashItems filters by id substring', () => {
  const items = buildSlashItems({ skills, promptTemplates: templates, query: 'ppt' })
  // ppt skill + ppt-outline template
  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'ppt')
  assert.equal(items[0].kind, 'skill')
  assert.equal(items[1].id, 'ppt-outline')
  assert.equal(items[1].kind, 'prompt-template')
})

test('buildSlashItems filters by name substring', () => {
  const items = buildSlashItems({ skills, promptTemplates: templates, query: '问候' })
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'greeting')
})

test('buildSlashItems case insensitive', () => {
  const items = buildSlashItems({
    skills: [{ id: 'PPT', name: '大写' }],
    promptTemplates: [],
    query: 'ppt',
  })
  assert.equal(items.length, 1)
})

test('buildSlashItems handles missing fields gracefully', () => {
  const items = buildSlashItems({
    skills: [{ id: 'x' }],
    promptTemplates: [{ id: 'y' }],
    query: '',
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].desc, '')
  assert.equal(items[1].desc, '')
})

test('renderPromptTemplate substitutes {{var}}', () => {
  const out = renderPromptTemplate('hello {{name}}', { name: 'world' })
  assert.equal(out, 'hello world')
})

test('renderPromptTemplate missing var → empty', () => {
  const out = renderPromptTemplate('hello {{name}}', {})
  assert.equal(out, 'hello ')
})

test('renderPromptTemplate handles undefined input', () => {
  assert.equal(renderPromptTemplate(undefined), '')
  assert.equal(renderPromptTemplate(null), '')
})

test('renderPromptTemplate tolerates whitespace inside braces', () => {
  const out = renderPromptTemplate('hi {{ name }}', { name: 'a' })
  assert.equal(out, 'hi a')
})
