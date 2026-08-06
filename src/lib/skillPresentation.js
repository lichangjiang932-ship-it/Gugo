const ZH_SKILL_COPY = {
  brainstorming: ['创意构思', '在开始创作或功能设计前梳理目标、需求与方案。'],
  'code-review': ['代码审查', '检查代码质量、安全问题、潜在缺陷与测试遗漏。'],
  'codex-superpowers-debugging': ['系统化调试', '基于证据定位根因，验证修复并防止问题复发。'],
  'dispatching-parallel-agents': ['并行任务调度', '把互不依赖的工作拆分给多个智能体并行处理。'],
  'evaluate-plugin': ['插件评估', '从工程质量、可用性与维护成本等方面评估插件。'],
  'evaluate-skill': ['技能评估', '检查技能的指令质量、执行效果与改进空间。'],
  'executing-plans': ['计划执行', '按照既定实施计划推进任务，并在关键节点检查结果。'],
  'connector-operator': ['连接器操作员', '安全使用已连接的应用与服务，处理权限、状态和错误。'],
  'needs-runtime-skill': ['运行时技能', '此技能需要额外运行环境，配置完成后即可使用。'],
}

const ZH_CATEGORY_COPY = [
  [/debug|diagnos|troubleshoot/i, ['问题诊断', '系统定位问题根因，并给出可验证的修复方案。']],
  [/review|audit|quality/i, ['质量审查', '检查内容或代码质量，识别风险并提出改进建议。']],
  [/test|verify|validation/i, ['测试验证', '设计并执行验证流程，确认结果符合预期。']],
  [/plan|task|execut|dispatch|parallel|agent/i, ['任务规划', '拆解任务、安排执行顺序并跟踪关键结果。']],
  [/brainstorm|design|creative|ideat/i, ['创意设计', '梳理创意方向、需求约束与可行方案。']],
  [/plugin|skill|extension/i, ['扩展工具', '用于管理、评估或改进技能与插件。']],
  [/connect|browser|web|github|notion|slack|drive/i, ['连接器操作', '调用已连接的应用与服务完成读取或操作。']],
  [/document|doc|write|report/i, ['文档处理', '起草、整理或优化结构清晰的文档内容。']],
  [/sheet|excel|data|table|analysis/i, ['数据分析', '整理数据、执行分析并输出清晰结论。']],
  [/slide|ppt|presentation/i, ['演示制作', '规划并制作结构清晰、视觉统一的演示内容。']],
]

function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''))
}

export function getPresentedSkill(skill, lang = 'zh') {
  if (!skill || !String(lang).startsWith('zh')) return skill
  const known = ZH_SKILL_COPY[skill.id]
  if (known) return { ...skill, name: known[0], desc: known[1] }
  if (containsChinese(skill.name) && containsChinese(skill.desc)) return skill
  const haystack = `${skill.id || ''} ${skill.name || ''} ${skill.desc || ''}`
  const category = ZH_CATEGORY_COPY.find(([pattern]) => pattern.test(haystack))?.[1]
  if (!category) return { ...skill, name: containsChinese(skill.name) ? skill.name : '通用技能', desc: '按预设流程协助完成专业任务。' }
  return {
    ...skill,
    name: containsChinese(skill.name) ? skill.name : category[0],
    desc: containsChinese(skill.desc) ? skill.desc : category[1],
  }
}
