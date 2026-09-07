
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

test('ppt skill requests real file delivery while honoring outline-only or source-only requests', () => {
  const prompt = promptOf('ppt')
  assert.match(prompt, /create_pptx/)
  assert.match(prompt, /outline or source only/)
  assert.match(prompt, /user's actual prompt/)
  assert.doesNotMatch(prompt, /只输出 Markdown 正文|第二行必须是页面类型注释|严禁连续 3 页|MBB/)
})

test('ppt skill preserves requested content, total count and factual evidence without a fixed genre', () => {
  const prompt = promptOf('ppt')
  assert.match(prompt, /N total slides/)
  assert.match(prompt, /without a cover/)
  assert.match(prompt, /Do not invent data/)
  assert.match(prompt, /Do not truncate/)
  assert.doesNotMatch(prompt, /尽量给数字|默认 8-12 页|节奏模板|商业演示导演/)
})

test('canonical ppt prompt gives the model native design controls without a mandatory layout preset', () => {
  const prompt = promptOf('ppt')
  for (const field of ['background', 'heading_font', 'body_font', 'east_asian_font', 'aspect_ratio', 'show_page_numbers', 'show_brand', 'show_date']) {
    assert.ok(prompt.includes(field), field)
  }
  assert.match(prompt, /slides\[\]\.elements/)
  assert.match(prompt, /editable text/)
  assert.match(prompt, /clipping|overflow/)
  assert.doesNotMatch(prompt, /fixed 16:9 canvas|6% horizontal and 8% vertical safe area|Vary the composition every 2-3 pages/)
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
