
import test from 'node:test'
import assert from 'node:assert/strict'
import { SKILLS } from '../src/data.js'

function promptOf(id) {
  const skill = SKILLS.find((item) => item.id === id)
  assert.ok(skill, `missing skill ${id}`)
  return skill.systemPrompt
}

test('htmlppt prompt asks for varied visual systems rather than one fixed dark style', () => {
  const prompt = promptOf('htmlppt')
  assert.match(prompt, /视觉系统/)
  assert.match(prompt, /Across the deck, use at least 4 visual element families/)
  assert.match(prompt, /no more than 2 primary decorative families/)
  assert.match(prompt, /连续页面不能长得一样/)
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

test('htmlppt prompt requires single-file offline deck with conversion hooks', () => {
  const prompt = promptOf('htmlppt')
  assert.match(prompt, /单文件零外部依赖/)
  assert.match(prompt, /禁止外链 CSS、JS、字体、图片、CDN/)
  assert.match(prompt, /data-slide="N"/)
  assert.match(prompt, /window\.__ymaDeck/)
  assert.match(prompt, /yma-deck-next/)
})

test('htmlppt prompt protects a centered 16:9 safe area and forbids text ghosting', () => {
  const prompt = promptOf('htmlppt')
  assert.match(prompt, /fixed `16:9` canvas/)
  assert.match(prompt, /6% horizontal and 8% vertical safe area/)
  assert.match(prompt, /22px for body copy/)
  assert.match(prompt, /Never apply text-shadow/)
  assert.match(prompt, /no more than 2 primary decorative families/)
})

test('every built-in skill is unique, bounded, language-aware, and fact-safe', () => {
  assert.equal(new Set(SKILLS.map((skill) => skill.id)).size, SKILLS.length)
  for (const skill of SKILLS) {
    assert.ok(skill.systemPrompt.length < 24_000, `${skill.id} prompt is too large: ${skill.systemPrompt.length}`)
    assert.match(skill.systemPrompt, /Match the user's language/)
    assert.match(skill.systemPrompt, /Never invent measurements, citations, people, dates, credentials, or completed actions/)
  }
})

test('legacy Axi PPT is a compatibility alias of the verified HTML PPT flow', () => {
  const skill = SKILLS.find((item) => item.id === 'axippt')
  assert.equal(skill.aliasFor, 'htmlppt')
  assert.equal(skill.recommended, false)
  assert.match(skill.systemPrompt, /Axi compatibility preset/)
  assert.match(skill.systemPrompt, /fixed `16:9` canvas/)
  assert.doesNotMatch(skill.systemPrompt, /PHASE 1|plan IN CHINESE|picsum\.photos/)
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
