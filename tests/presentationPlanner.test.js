import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPresentationPlannerPrompt,
  buildSlideBlueprint,
  inferRequestedSlideCount,
  selectPresentationTemplate,
} from '../src/lib/presentationPlanner.js'

test('explicit legacy template helpers still support a technology blueprint', () => {
  const template = selectPresentationTemplate('/ppt 做一个关于 DeepSeek V4 Pro 的 ppt5页，高级感，内容充实')
  const blueprint = buildSlideBlueprint(template, 5)

  assert.equal(template.id, 'technology')
  assert.equal(blueprint.length, 5)
  assert.equal(blueprint[0].type, 'cover')
  assert.equal(blueprint.at(-1).type, 'end')
  assert.ok(blueprint.some((slot) => ['data', 'chart'].includes(slot.type)), 'technology deck needs a proof/data page')
  assert.ok(blueprint.some((slot) => /system|architecture|mechanism/i.test(slot.intent)))
})

test('explicit legacy template helpers still support investor pitch topics', () => {
  const template = selectPresentationTemplate('帮我做一份 A 轮融资路演 deck，讲 TAM、商业模式、资金用途')
  const blueprint = buildSlideBlueprint(template, 8)

  assert.equal(template.id, 'fundraising')
  assert.equal(blueprint.length, 8)
  assert.ok(blueprint.some((slot) => /market|TAM/i.test(slot.intent)))
  assert.ok(blueprint.some((slot) => /funding|use of funds/i.test(slot.intent)))
})

test('requested slide counts remain exact instead of being clamped to a preset range', () => {
  for (const count of [1, 2, 3, 5, 9, 20, 99, 100, 101]) {
    assert.equal(inferRequestedSlideCount(`做一个${count}页ppt，不要封面`), count)
    assert.equal(inferRequestedSlideCount(`make a ${count}-page deck`), count)
  }
  assert.equal(inferRequestedSlideCount('做一个二十页演示'), 20)
  assert.equal(inferRequestedSlideCount('做一个九十九页演示'), 99)
  assert.equal(inferRequestedSlideCount('做一个一页演示'), 1)
  assert.equal(inferRequestedSlideCount('随便做个ppt'), null)
})

test('explicit blueprint expansion preserves small and large counts and rejects unsupported counts openly', () => {
  const template = selectPresentationTemplate('technology')
  for (const count of [1, 2, 20, 99, 100]) {
    const blueprint = buildSlideBlueprint(template, count)
    assert.equal(blueprint.length, count)
    assert.deepEqual(blueprint.map((item) => item.page), Array.from({ length: count }, (_, index) => index + 1))
  }
  for (const count of [0, -1, 1.5, 101]) {
    assert.throws(() => buildSlideBlueprint(template, count), RangeError)
  }
})

test('default planner forwards the user request verbatim without injecting template slots or design defaults', () => {
  const request = '制作 1 页诗歌赏析，不要封面、目录或结束页。\n用 4:3、宋体、淡绿色；正文逐字保留，不加图表。'
  const expected = `\n\n## User presentation request\n${request}`
  for (const skillId of ['ppt', 'htmlppt']) {
    const prompt = buildPresentationPlannerPrompt(request, { skillId })
    assert.equal(prompt, expected)
    assert.doesNotMatch(prompt, /Template library|Selected template|Page-by-page blueprint|Page 0|fixed 16:9|64px/)
  }
})

test('unspecified page count or style does not create a default storyline or an extra configuration step', () => {
  const request = '做一份儿童绘本风格的演示'
  assert.equal(buildPresentationPlannerPrompt(request), `\n\n## User presentation request\n${request}`)
  assert.equal(buildPresentationPlannerPrompt(''), '')
})
