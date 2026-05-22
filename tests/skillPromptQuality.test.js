
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
  assert.match(prompt, /至少 4 类视觉元素/)
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
