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

  if (/\bdata\s*analy|\b数据(分析|洞察)|\bcsv.*分析|\b表格.*分析|\b趋势.*分析/i.test(text)) {
    return 'data_analysis'
  }

  if (/\bcode\s*review|\b代码(审查|审核|review)|\breview.*代码|\b代码(质量|优化|重构)/i.test(text)) {
    return 'code_review'
  }

  if (/\b(mind\s*map|思维导图|脑图|心智图)/i.test(text)) {
    return 'mindmap'
  }

  if (/\b(translat|翻译|翻成|译成|译自|中日|中英|英汉)/i.test(text)) {
    return 'translation'
  }

  if (/(流程图|架构图|时序图|类图|甘特图|思维导图|mermaid)/i.test(text)) {
    return 'mindmap'
  }

  if (/\b(research|调研|研究报告|行业分析|市场(研究|调查)|文献综述)/i.test(text)) {
    return 'research'
  }

  if (/\b(image\s*prompt|生成图片|画图|绘画|midjourney|dall|stable\s*diffusion)/i.test(text)) {
    return 'image_prompt'
  }

  return null
}
