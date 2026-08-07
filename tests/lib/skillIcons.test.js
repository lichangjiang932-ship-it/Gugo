import test from 'node:test'
import assert from 'node:assert/strict'

import { FileText, Mail, Presentation, Wrench } from 'lucide-react'
import { SKILLS } from '../../src/data.js'
import { getSkillIcon, getSkillIconPresentation, SKILL_ICONS } from '../../src/lib/skillIcons.js'

// lucide-react 图标是 React.forwardRef 对象（{ $$typeof, render }），
// 也可能是普通函数组件。两种都接受。
function isReactComponent(value) {
  if (typeof value === 'function') return true
  if (value && typeof value === 'object' && typeof value.render === 'function') return true
  return false
}

test('getSkillIcon 为内置 12 个 skill 都返回一个 React 组件', () => {
  assert.equal(SKILLS.length, 12, 'SKILLS 应当是 12 项')
  for (const skill of SKILLS) {
    const Icon = getSkillIcon(skill.id)
    assert.ok(
      isReactComponent(Icon),
      `skill ${skill.id} 的图标应当是 React 组件，但拿到 ${typeof Icon}`,
    )
  }
})

test('每个内置 skill 都登记在 SKILL_ICONS 里（无未映射）', () => {
  for (const skill of SKILLS) {
    assert.ok(
      SKILL_ICONS[skill.id],
      `skill ${skill.id} 应当在 SKILL_ICONS 显式登记`,
    )
  }
})

test('getSkillIcon 对未知 id 回退到 Wrench', () => {
  assert.equal(getSkillIcon('unknown_id_xxx'), Wrench)
  assert.equal(getSkillIcon(''), Wrench)
  assert.equal(getSkillIcon(undefined), Wrench)
  assert.equal(getSkillIcon(null), Wrench)
})

test('插件与自定义技能按完整元数据获得稳定的语义图标', () => {
  assert.equal(getSkillIcon({ id: 'third-party-writer', name: 'Word 文档生成' }), FileText)
  assert.equal(getSkillIcon({ id: 'enterprise-message', desc: '通过 IMAP/SMTP 收发邮件' }), Mail)
  assert.equal(getSkillIcon({ id: 'deck-studio', originalName: 'presentation-builder' }), Presentation)
  assert.equal(getSkillIcon({ id: 'unknown_id_xxx', name: '未分类能力' }), Wrench)

  const first = getSkillIconPresentation({ id: 'deck-studio', name: 'Slides' })
  const second = getSkillIconPresentation({ id: 'deck-studio', name: 'Slides' })
  assert.equal(first.Icon, second.Icon)
  assert.equal(first.className, second.className)
})
