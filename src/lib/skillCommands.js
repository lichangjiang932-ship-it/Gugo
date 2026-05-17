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

  return null
}
