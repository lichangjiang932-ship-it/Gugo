
import test from 'node:test'
import assert from 'node:assert/strict'
import { SKILLS } from '../src/data.js'
import { canonicalizeSkillId } from '../shared/artifactIntent.js'

function promptOf(id) {
  const skill = SKILLS.find((item) => item.id === id)
  assert.ok(skill, `missing skill ${id}`)
  return skill.systemPrompt
}

test('built-in catalog exposes one canonical presentation skill', () => {
  const presentationSkills = SKILLS.filter((skill) => canonicalizeSkillId(skill.id) === 'ppt')
  assert.deepEqual(presentationSkills.map((skill) => skill.id), ['ppt'])
  assert.equal(presentationSkills[0].recommended, true)
})

test('ppt prompts require exportable slide structure and no useless tail text', () => {
  const prompt = promptOf('ppt')
  assert.match(prompt, /第二行必须是页面类型注释/)
  assert.match(prompt, /严禁连续 3 页/)
  assert.match(prompt, /禁止输出“以下是一份方案”/)
  assert.match(prompt, /可直接导出 PPTX/)
})

test('ppt prompt requires evidence-rich content instead of thin bullets', () => {
  const prompt = promptOf('ppt')
  assert.match(prompt, /主张；证据/)
  assert.match(prompt, /用户要求页数/)
  assert.match(prompt, /不要空泛形容词/)
})

test('canonical ppt prompt enforces renderer-neutral visual quality', () => {
  const prompt = promptOf('ppt')
  assert.match(prompt, /fixed 16:9 canvas/)
  assert.match(prompt, /6% horizontal and 8% vertical safe area/)
  assert.match(prompt, /deliberate type hierarchy/)
  assert.match(prompt, /Vary the composition every 2-3 pages/)
  assert.match(prompt, /editable text/)
  assert.match(prompt, /Never duplicate visible text layers or apply text-shadow/)
  assert.match(prompt, /absence of clipping or ghosting/)
})

test('every built-in skill is unique, bounded, language-aware, and fact-safe', () => {
  assert.equal(new Set(SKILLS.map((skill) => skill.id)).size, SKILLS.length)
  for (const skill of SKILLS) {
    assert.ok(skill.systemPrompt.length < 24_000, `${skill.id} prompt is too large: ${skill.systemPrompt.length}`)
    assert.match(skill.systemPrompt, /Match the user's language/)
    assert.match(skill.systemPrompt, /Never invent measurements, citations, people, dates, credentials, or completed actions/)
  }
})

test('web, document, spreadsheet, and mail skills describe honest artifact boundaries', () => {
  assert.match(promptOf('webpage'), /Default to offline-safe output/)
  assert.doesNotMatch(promptOf('webpage'), /picsum\.photos|placehold\.co/i)
  assert.match(promptOf('webpage'), /Do not leave .*fake customer claims/)
  assert.match(promptOf('doc'), /If a document artifact tool is available/)
  assert.match(promptOf('excel'), /real workbook through an available spreadsheet artifact tool/)
  assert.match(promptOf('mail'), /Drafting and sending are separate actions/)
  assert.match(promptOf('mail'), /explicit confirmation immediately before the external send/)
})

test('analysis skills protect evidence quality and adapt to the target project', () => {
  assert.match(promptOf('finance'), /never manufacture a number/)
  assert.match(promptOf('review'), /severity P0-P3/)
  assert.match(promptOf('review'), /line range only when source locations are available/)
  assert.match(promptOf('review'), /Do not use star ratings/)
  assert.match(promptOf('test'), /Inspect current tests before selecting a framework/)
  assert.match(promptOf('test'), /do not assume .*coverage target/i)
  assert.doesNotMatch(promptOf('test'), /> 85%/)
  assert.match(promptOf('research'), /publication date when known, and access date/)
  assert.match(promptOf('plan'), /definition of done/)
})

test('translation preserves machine-readable text and avoids unconditional glossary noise', () => {
  const prompt = promptOf('translate')
  assert.match(prompt, /placeholders, template variables, HTML tags, code, identifiers/)
  assert.match(prompt, /Add a term table or translator notes only when the user asks/)
})
