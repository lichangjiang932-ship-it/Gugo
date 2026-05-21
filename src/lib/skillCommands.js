export function parseSkillCommand(content = '') {
  const match = String(content).match(/^\/([a-z0-9_-]+)\s*(.*)$/i)
  if (!match) return { skillId: null, userPrompt: String(content || '') }
  return {
    skillId: match[1],
    userPrompt: match[2],
  }
}

export function inferSkillIdFromPrompt(content = '') {
  const text = String(content || '').trim().toLowerCase()
  if (!text || text.startsWith('/')) return null

  if (
    /\bhtml\s*ppt\b/i.test(text) ||
    /高级感\s*(?:html\s*)?ppt/i.test(text) ||
    /html\s*幻灯片/i.test(text)
  ) {
    return 'htmlppt'
  }

  if (
    /\bpptx?\b/i.test(text) ||
    /幻灯片|演示文稿|路演稿|汇报\s*ppt/i.test(text)
  ) {
    return 'ppt'
  }

  if (/代码审查|code\s*review|review\s*code|审查代码|代码质量|bug\s*检查/i.test(text)) return 'review'
  if (/写测试|生成测试|test\s*case|单元测试|add\s*test/i.test(text)) return 'test'
  if (/翻译|translate|英译中|中译英|translate\s*to/i.test(text)) return 'translate'
  if (/调研|行业分析|市场分析|竞品|research|行业研究/i.test(text)) return 'research'
  if (/项目计划|任务拆解|milestone|project\s*plan|规划|实施方案/i.test(text)) return 'plan'
  if (/生成代码|写代码|写一个|实现一个|create\s*a\s*component|coding|编程|重构|refactor/i.test(text)) return 'code'

  return null
}
