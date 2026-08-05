const SKILL_ARTIFACT_TOOL = Object.freeze({
  ppt: 'create_pptx',
  doc: 'create_docx',
  excel: 'create_xlsx',
})

// 常见 PPT/文档/表格类技能 ID → 文件工具映射。技能前缀（如 /ppt-master 做演示）
// 在 skillId 无法精确命中时按关键词判定，而"做演示"这类短指令没有 artifact 名词，
// 会漏解锁；这里把已知技能 ID 显式归类，前缀命中即解锁对应工具。
const SKILL_ID_ALIASES = Object.freeze({
  ppt: ['ppt', 'ppt-master', 'axippt', 'htmlppt', 'guizang-ppt'],
  doc: ['doc', 'write-doc'],
  excel: ['excel', 'analyze-excel'],
})

export function resolveArtifactToolForSkillId(skillId) {
  const id = String(skillId || '').toLowerCase()
  if (SKILL_ARTIFACT_TOOL[id]) return SKILL_ARTIFACT_TOOL[id]
  for (const [kind, aliases] of Object.entries(SKILL_ID_ALIASES)) {
    if (aliases.includes(id)) return SKILL_ARTIFACT_TOOL[kind]
  }
  return null
}

const ARTIFACT_TERMS = Object.freeze({
  pptx: /\bpptx?\b|\.pptx?\b|power\s*point|幻灯片|演示文稿|演示稿|路演稿|slide\s*deck|\bslides?\b/gi,
  docx: /\bdocx?\b|\.docx?\b|\bword\b|word\s*文档|文档|报告|会议纪要|纪要|周报|合同|简历|document|report|minutes/gi,
  xlsx: /\bxlsx?\b|\.xlsx?\b|\bexcel\b|工作簿|电子表格|spread\s*sheet/gi,
})

const BEFORE_ACTION = /(?:帮我|请|麻烦|给我|我要|我需要|我想要|希望|来(?:一|个|份|套)?|写|编写|撰写|做|制作|生成|创建|输出|导出|整理成|转换成|转成|改成|做成|设计|起草|重做|重制|修改|编辑|更新|优化|润色|make|create|generate|build|produce|export|convert|design|draft|prepare|write|revise|edit|update|redesign|give\s+me|i\s+(?:want|need))[^。！？!?\n]{0,32}$/i
const AFTER_ACTION = /^[^。！？!?\n]{0,12}(?:写|编写|撰写|做|制作|生成|创建|输出|导出|重做|修改|编辑|更新|优化|润色|make|create|generate|export|edit|update)/i
const DIRECT_NEGATION = /(?:不要|不再|别再?|禁止|避免|无需|不用|不需要|不可|不能|不应|不想要|勿|拒绝|防止|阻止|确保不会|没有要求|没要求|没有让|没让|未要求|without|do\s+not|don't|dont|never|avoid|prevent|stop|must\s+not|should\s+not|no\s+need\s+to)[^。！？!?\n]{0,28}$/i
const AUTO_OR_ACCIDENTAL = /(?:自动|随意|擅自|自行|莫名|错误|意外|偷偷|被|乱)[^。！？!?\n]{0,10}(?:生成|制作|创建|输出|导出|变成|转成|generate|create|make|export)[^。！？!?\n]{0,8}$/i
const META_QUESTION = /(?:为什么|为何|怎么会|怎会|如何避免|排查|检查|调查|修复|解决|防止|阻止|关于|提到|讨论|解释|原因|问题|bug|逻辑|代码|工具|why|how\s+did|fix|debug|investigate|prevent|stop|about|discuss)[^。！？!?\n]{0,28}$/i
const CAPABILITY_QUESTION = /(?:能不能|能否|可以不可以|是否可以|会不会|能|可以)[^。！？!?\n]{0,8}(?:生成|制作|创建|导出)[^。！？!?\n]{0,4}$/i
const NEGATION_AFTER = /^[^。！？!?\n]{0,10}(?:不要|不用|不需要|禁止|别|无需|不可|不能|do\s+not|don't|dont|never|not\s+needed)/i
const META_AFTER = /^[^。！？!?\n]{0,12}(?:问题|bug|逻辑|代码|工具|为什么|为何|自动生成|误生成|被生成|乱生成|随意生成|problem|issue|bug|logic|tool)/i
const GLOBAL_DENIAL = /(?:没有|没|未)(?:有)?(?:让|要求|叫|授权)[^。！？!?\n]{0,18}(?:生成|制作|创建|输出|导出|变成|转成)|(?:i\s+did(?:\s+not|n't)|without\s+me)\s+(?:ask|request|authoriz)[^.!?\n]{0,24}(?:creat|generat|mak|export)/i
const SKILL_PREFIX = /^\/([a-z0-9_-]+)(?:\s|$)/i

export function parseArtifactSkillId(prompt = '') {
  const match = String(prompt || '').trim().match(SKILL_PREFIX)
  return match ? match[1].toLowerCase() : null
}

function occurrenceIsExplicitRequest(text, match) {
  const before = text.slice(Math.max(0, match.index - 48), match.index)
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 32)
  const identifierPrefix = text.slice(Math.max(0, match.index - 16), match.index)

  if (/create[_-]$/i.test(identifierPrefix)) return false
  if (DIRECT_NEGATION.test(before) || NEGATION_AFTER.test(after)) return false
  if (AUTO_OR_ACCIDENTAL.test(before) || CAPABILITY_QUESTION.test(before)) return false

  const requested = BEFORE_ACTION.test(before) || AFTER_ACTION.test(after)
  if (!requested) return false
  if (META_QUESTION.test(before) && !/(?:帮我|请|麻烦|给我|我要|我需要|我想要|make|create|generate|export|give\s+me|i\s+(?:want|need))[^。！？!?\n]{0,24}$/i.test(before)) {
    return false
  }
  if (META_AFTER.test(after) && !/(?:修改|编辑|更新|优化|润色|重做|edit|update|revise|redesign)[^。！？!?\n]{0,20}$/i.test(before)) {
    return false
  }
  return true
}

export function hasExplicitArtifactRequest(prompt = '', type) {
  const text = String(prompt || '').trim()
  const matcher = ARTIFACT_TERMS[type]
  if (!text || !matcher) return false
  if (GLOBAL_DENIAL.test(text)) return false
  matcher.lastIndex = 0
  for (const match of text.matchAll(matcher)) {
    if (occurrenceIsExplicitRequest(text, match)) return true
  }
  return false
}

export function detectArtifactIntent(prompt = '', { skillId = undefined } = {}) {
  const text = String(prompt || '')
  const resolvedSkill = skillId === undefined ? parseArtifactSkillId(text) : skillId
  const skillTool = resolvedSkill ? resolveArtifactToolForSkillId(resolvedSkill) : null
  return {
    pptx: skillTool === 'create_pptx' || hasExplicitArtifactRequest(text, 'pptx'),
    docx: skillTool === 'create_docx' || hasExplicitArtifactRequest(text, 'docx'),
    xlsx: skillTool === 'create_xlsx' || hasExplicitArtifactRequest(text, 'xlsx'),
  }
}
