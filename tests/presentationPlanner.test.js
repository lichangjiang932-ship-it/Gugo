import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPresentationPlannerPrompt,
  buildSlideBlueprint,
  inferRequestedSlideCount,
  selectPresentationTemplate,
} from '../src/lib/presentationPlanner.js'

test('presentation planner routes AI model topics to a technology blueprint', () => {
  const template = selectPresentationTemplate('/ppt 做一个关于 DeepSeek V4 Pro 的 ppt5页，高级感，内容充实')
  const blueprint = buildSlideBlueprint(template, 5)

  assert.equal(template.id, 'technology')
  assert.equal(blueprint.length, 5)
  assert.equal(blueprint[0].type, 'cover')
  assert.equal(blueprint.at(-1).type, 'end')
  assert.ok(blueprint.some((slot) => ['data', 'chart'].includes(slot.type)), 'technology deck needs a proof/data page')
  assert.ok(blueprint.some((slot) => /system|architecture|mechanism/i.test(slot.intent)))
})

test('presentation planner chooses fundraising slots for investor pitch topics', () => {
  const template = selectPresentationTemplate('帮我做一份 A 轮融资路演 deck，讲 TAM、商业模式、资金用途')
  const blueprint = buildSlideBlueprint(template, 8)

  assert.equal(template.id, 'fundraising')
  assert.equal(blueprint.length, 8)
  assert.ok(blueprint.some((slot) => /market|TAM/i.test(slot.intent)))
  assert.ok(blueprint.some((slot) => /funding|use of funds/i.test(slot.intent)))
})

test('presentation planner extracts requested slide counts and clamps unsafe values', () => {
  assert.equal(inferRequestedSlideCount('做一个5页ppt'), 5)
  assert.equal(inferRequestedSlideCount('make a 9 page pitch deck'), 9)
  assert.equal(inferRequestedSlideCount('做一个99页ppt'), 16)
  assert.equal(inferRequestedSlideCount('随便做个ppt'), null)
})

test('planner prompt injects a strict page-by-page slot plan for ppt and htmlppt', () => {
  const pptPrompt = buildPresentationPlannerPrompt('DeepSeek V4 Pro ppt5页', { skillId: 'ppt' })
  const htmlPrompt = buildPresentationPlannerPrompt('DeepSeek V4 Pro html ppt5页', { skillId: 'htmlppt' })

  assert.match(pptPrompt, /Template library planner/)
  assert.match(pptPrompt, /Selected template: technology/)
  assert.match(pptPrompt, /Strict slide count: 5/)
  assert.match(pptPrompt, /Page 03/)
  assert.match(pptPrompt, /<!-- data -->|<!-- chart -->/)

  assert.match(htmlPrompt, /Selected template: technology/)
  assert.match(htmlPrompt, /section class="slide/)
  assert.match(htmlPrompt, /data-slide="3"/)
})
