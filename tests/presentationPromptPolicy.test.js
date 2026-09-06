import assert from 'node:assert/strict'
import test from 'node:test'

import { PRESENTATION_PROMPT_POLICY, PRESENTATION_VISUAL_POLICY, inferPresentationSlideCount } from '../shared/presentationPromptPolicy.js'
import { SKILLS, getSkillSystemPrompt } from '../src/data.js'
import { buildPresentationPlannerPrompt } from '../src/lib/presentationPlanner.js'
import { buildArtifactPrompt } from '../server/services/jobPromptBlocks.js'
import { getRuntimeSkill } from '../server/services/skillRegistry.js'
import { buildSkillsBlockFromPrepared, prepareSkillsForPrompt } from '../server/services/promptCompiler.js'
import { PPTX_DESIGN_SCHEMA } from '../server/services/pptxArtifactContract.js'
import { closeDb } from '../server/db.js'

test.after(() => closeDb())

test('chat and background PPT prompts use the same user-directed request and native-design policies', () => {
  const chat = SKILLS.find((skill) => skill.id === 'ppt').systemPrompt
  const job = buildArtifactPrompt(new Set(['create_pptx']))
  for (const prompt of [chat, job]) {
    assert.ok(prompt.includes(PRESENTATION_PROMPT_POLICY))
    assert.ok(prompt.includes(PRESENTATION_VISUAL_POLICY))
    assert.match(prompt, /N total slides/)
    assert.match(prompt, /without a cover/)
    assert.match(prompt, /Never silently clamp/)
    assert.match(prompt, /Make unspecified visual choices yourself/)
    assert.match(prompt, /Do not introduce a template selector/)
    assert.doesNotMatch(prompt, /fixed 16:9|MBB|consulting-grade|章节分隔 \+ 至少|标题 ≤ 14|每页至少/)
  }
  assert.equal(buildArtifactPrompt(new Set(['create_pdf'])).includes(PRESENTATION_PROMPT_POLICY), false)
})

test('the actual runtime registry and prompt compiler load the updated canonical PPT skill', () => {
  const runtimeSkill = getRuntimeSkill('ppt', { userId: null })
  assert.ok(runtimeSkill.systemPrompt.includes(PRESENTATION_PROMPT_POLICY))
  const prepared = prepareSkillsForPrompt({ userId: null, skillIds: ['ppt'] })
  assert.equal(prepared.length, 1)
  assert.ok(prepared[0].systemPrompt.includes(PRESENTATION_VISUAL_POLICY))
  const block = buildSkillsBlockFromPrepared({ userId: null, skills: prepared })
  assert.ok(block.text.includes(PRESENTATION_PROMPT_POLICY))
  assert.match(block.text, /create_pptx/)
  assert.match(block.text, /gugo-skill-quality:v1/)
  assert.match(block.text, /### slides verification/)
  assert.doesNotMatch(block.text, /只输出 Markdown 正文|fixed 16:9 canvas|Vary the composition every 2-3 pages/)
})

test('presentation authoring guidance uses real design fields and authorized native elements', () => {
  for (const field of Object.keys(PPTX_DESIGN_SCHEMA.properties)) {
    assert.ok(PRESENTATION_VISUAL_POLICY.includes(field), `missing native design field: ${field}`)
  }
  assert.match(PRESENTATION_VISUAL_POLICY, /slides\[\]\.elements/)
  assert.match(PRESENTATION_VISUAL_POLICY, /0\.\.1/)
  assert.match(PRESENTATION_VISUAL_POLICY, /x\+w <= 1 and y\+h <= 1/)
  assert.match(PRESENTATION_VISUAL_POLICY, /A line may use zero width or zero height/)
  assert.match(PRESENTATION_VISUAL_POLICY, /but not both zero/)
  assert.match(PRESENTATION_VISUAL_POLICY, /image_index/)
  assert.match(PRESENTATION_VISUAL_POLICY, /authorized by the host/)
  assert.match(PRESENTATION_VISUAL_POLICY, /Never inject raw file paths, URLs, data URIs or executable code/)
  assert.match(PRESENTATION_VISUAL_POLICY, /optional compatibility helpers/)
})

test('custom instructions and complete multiline user content survive for 1, 20 and 99 total pages', () => {
  const custom = 'Use my classroom poem verbatim, a 4:3 canvas, and the supplied chalkboard palette.'
  for (const count of [1, 20, 99]) {
    const userPrompt = `制作${count}页，不要封面或结束页，不要图表。\n原文：“山间清风，窗前月色。”\n逐字保留，宋体，淡绿色。`
    assert.equal(inferPresentationSlideCount(userPrompt), count)
    assert.equal(buildPresentationPlannerPrompt(userPrompt), `\n\n## User presentation request\n${userPrompt}`)
    const result = getSkillSystemPrompt('ppt', { ppt: { systemPrompt: custom } }, [], { userPrompt, split: true })
    assert.equal(result.base, custom)
    assert.equal(result.perTurn, `\n\n## User presentation request\n${userPrompt}`)
  }
})

test('PPT freedom does not loosen factual, output-format, or permission boundaries', () => {
  assert.match(PRESENTATION_PROMPT_POLICY, /Do not invent data, statistics, sources/)
  assert.match(PRESENTATION_PROMPT_POLICY, /Do not truncate text or drop data/)
  assert.match(PRESENTATION_PROMPT_POLICY, /outline or source only/)
  assert.match(PRESENTATION_PROMPT_POLICY, /without creating an unsolicited file/)
  assert.match(PRESENTATION_PROMPT_POLICY, /do not bypass filesystem, network, tool or external-action approval boundaries/)
  assert.match(PRESENTATION_PROMPT_POLICY, /actual tool evidence/)
  assert.match(PRESENTATION_VISUAL_POLICY, /state any checks that could not be completed/)
})

test('count extraction neither infers missing counts nor turns ordinals or invalid numbers into totals', () => {
  for (const prompt of ['按内容决定页数', '检查第20页', '0页', '-3页', '做1.5页']) {
    assert.equal(inferPresentationSlideCount(prompt), null, prompt)
  }
  assert.equal(inferPresentationSlideCount('make 120 slides'), 120, 'unsupported counts stay explicit for the real tool boundary')
})
