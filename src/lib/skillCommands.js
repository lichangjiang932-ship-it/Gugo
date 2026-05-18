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

  // axippt：顶级 HTML PPT（咨询风/科技/禅意/政务等 8 种风格）
  if (
    /\baxi\b/i.test(text) ||
    /\baxippt\b/i.test(text) ||
    /顶级\s*ppt|咨询\s*风\s*ppt|高级\s*ppt|麦肯锡\s*ppt|bcg\s*ppt/i.test(text) ||
    /(咨询|科技|禅意|政务|杂志|像素).{0,4}(风|风格).{0,6}ppt/i.test(text)
  ) {
    return 'axippt'
  }

  // htmlppt：通用 HTML PPT
  if (
    /\bhtml\s*ppt\b/i.test(text) ||
    /高级感\s*(?:html\s*)?ppt/i.test(text) ||
    /html\s*幻灯片/i.test(text)
  ) {
    return 'htmlppt'
  }

  // ppt：原生 PPTX
  if (
    /\bpptx?\b/i.test(text) ||
    /幻灯片|演示文稿|路演稿|汇报\s*ppt/i.test(text)
  ) {
    return 'ppt'
  }

  // webpage：高级感网页 / 落地页
  if (
    /\b(landing|landingpage|landing\s*page)\b/i.test(text) ||
    /高级感\s*网页|高级\s*网页|落地\s*页|官网\s*首页|品牌\s*网页|营销\s*网页/i.test(text) ||
    /(做|生成|写|来\s*一个|来个).{0,4}(网页|页面|官网|landing)/i.test(text)
  ) {
    return 'webpage'
  }

  return null
}
