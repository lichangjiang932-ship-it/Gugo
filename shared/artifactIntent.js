export const PPT_SKILL_ID_ALIASES = Object.freeze([
  'ppt',
  'ppt-master',
  'axippt',
  'htmlppt',
  'guizang-ppt',
])

const PPT_SKILL_ID_ALIAS_SET = new Set(PPT_SKILL_ID_ALIASES)

export function canonicalizeSkillId(skillId) {
  const value = String(skillId ?? '').trim()
  if (!value) return null
  return PPT_SKILL_ID_ALIAS_SET.has(value.toLowerCase()) ? 'ppt' : value
}

const SKILL_ARTIFACT_TOOL = Object.freeze({
  ppt: 'create_pptx',
  doc: 'create_docx',
  excel: 'create_xlsx',
  webpage: 'create_html_app',
  pdf: 'create_pdf',
  image: 'generate_image',
})

// 常见 PPT/文档/表格类技能 ID → 文件工具映射。技能前缀（如 /ppt-master 做演示）
// 在 skillId 无法精确命中时按关键词判定，而"做演示"这类短指令没有 artifact 名词，
// 会漏解锁；这里把已知技能 ID 显式归类，前缀命中即解锁对应工具。
const SKILL_ID_ALIASES = Object.freeze({
  doc: ['doc', 'write-doc'],
  excel: ['excel', 'analyze-excel'],
  webpage: ['webpage', 'html', 'website'],
  pdf: ['pdf'],
  image: ['image', 'imagegen', 'image-gen'],
})

export function resolveArtifactToolForSkillId(skillId) {
  const id = String(canonicalizeSkillId(skillId) || '').toLowerCase()
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
  html: /\bhtml?\b|\.html?\b|\bweb\s*page\b|\bwebsite\b|\blanding\s*page\b|网页|网站|落地页/gi,
  pdf: /\bpdf\b|\.pdf\b|便携式文档/gi,
  image: /\bimages?\b|\bpictures?\b|\bphotos?\b|\billustrations?\b|\bposters?\b|\bcover\s+art\b|\bhero\s+art\b|\u56fe\u7247|\u56fe\u50cf|\u63d2\u56fe|\u914d\u56fe|\u6d77\u62a5|\u5c01\u9762\u56fe/gi,
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
// “请报告真实 exitCode / report the test result” asks the assistant to
// state execution evidence in chat. `报告` / `report` is a verb there, not
// a request for a downloadable Word document. Explicit authoring phrases
// (生成报告 / write a report) remain eligible for DOCX.
const RESULT_REPORT_OBJECT = /^[\s:：]*(?:(?:the\s+)?(?:real|actual|current|final|latest|specific)\s+|(?:真实|实际|当前|最终|最新|具体|本次)\s*)?(?:(?:test|check|verification|execution)\s+|(?:测试|检查|验证|执行)\s*)?(?:exit\s*code|exitcode|stdout|stderr|status|results?|progress|outcome|error|reason|findings?|退出码|结果|状态|进度|错误|异常|原因|结论|输出)/i
const ARTIFACT_PRODUCTION_BEFORE = /(?:写(?:一|1)?份|编写|撰写|制作|生成|创建|导出|整理成|转换成|make|create|generate|produce|export|draft|prepare|write)(?:[^。！？?!\n]{0,24})$/i
const SKILL_PREFIX = /^\/([a-z0-9_-]+)(?:\s|$)/i

// A slash artifact skill is a delivery contract, not merely another keyword.
// Keep it on its own generator unless the prompt clearly asks for an
// additional *file format*. This prevents content phrases such as
// "/webpage ... quarterly report" from silently turning one webpage into both
// HTML and DOCX, while still allowing "/webpage ... and a Word document".
const ADDITIONAL_ARTIFACT_CUE = /(?:\b(?:also|and|plus|both|too|as\s+well\s+as|along\s+with|additionally|separately)\b|\u540c\u65f6|\u53e6\u5916|\u53e6\u52a0|\u4ee5\u53ca|\u5e76\u4e14|\u518d(?:\u751f\u6210|\u521b\u5efa|\u5236\u4f5c|\u5bfc\u51fa)|\u5404(?:\u751f\u6210|\u521b\u5efa|\u5236\u4f5c|\u5bfc\u51fa)?(?:\u4e00|1)\u4efd)/i
const STRONG_ARTIFACT_FORMAT = Object.freeze({
  pptx: /\bpptx?\b|\.pptx?\b|power\s*point|slide\s*deck|\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f/i,
  docx: /\bdocx?\b|\.docx?\b|\bword\b|word\s*document|\u0057\u006f\u0072\u0064\s*\u6587\u6863|\u6587\u6863/i,
  xlsx: /\bxlsx?\b|\.xlsx?\b|\bexcel\b|spread\s*sheet|\u5de5\u4f5c\u7c3f|\u7535\u5b50\u8868\u683c/i,
  html: /\bhtml?\b|\.html?\b|\bweb\s*page\b|\bwebsite\b|\blanding\s*page\b|\u7f51\u9875|\u7f51\u7ad9|\u843d\u5730\u9875/i,
  pdf: /\bpdf\b|\.pdf\b|\u4fbf\u643a\u5f0f\u6587\u6863/i,
  image: /\bimages?\b|\bpictures?\b|\bphotos?\b|\billustrations?\b|\bposters?\b|\u56fe\u7247|\u56fe\u50cf|\u63d2\u56fe|\u914d\u56fe|\u6d77\u62a5|\u5c01\u9762\u56fe/i,
})

// A terse follow-up such as “这里不足，修改一下” intentionally omits the
// file format because the immediately preceding deliverable is the subject.
// This is deliberately action-oriented: merely discussing or asking about an
// older file must not keep artifact generators enabled forever.
const ARTIFACT_REVISION_ACTION = /(?:继续(?:修改|编辑|完善|优化|调整|润色|改进|补充|更新|迭代)|(?:请|帮我|麻烦)?(?:把|将)?(?:它|这个|这里|刚才的|上一个|上一版|该(?:文件|页面|文档|表格|演示|幻灯片))?[^。！？!?\n]{0,24}(?:修改|编辑|完善|优化|调整|润色|改进|补充|更新|迭代|重做|重制|替换|换成|改成|改(?:一?下)?|换(?:一?下|个)?|删(?:一?下|掉)?|删除|添加|加(?:一?下|上)?|补(?:一?下|上)?|缩小|放大)|(?:再|重新|继续|请|帮我|麻烦)?(?:改|换|删|加|补|调|修)(?:一?下|个|掉|成|为)?[^。！？!?\n]{0,24}|(?:这里|这版|上一版|刚才的)[^。！？!?\n]{0,24}(?:不足|不对|不好|有问题)[^。！？!?\n]{0,20}(?:改|修|调整|优化|完善)|(?:revise|edit|update|improve|refine|adjust|polish|iterate|redo|redesign|change|replace|remove|add|continue\s+(?:working|editing|improving))\b)/i
const ARTIFACT_REVISION_DENIAL = /(?:不要|不用|无需|别|禁止|停止|取消)[^，,；;：:。！？!?\n]{0,20}(?:修改|编辑|更新|优化|调整|重做|生成|导出)|(?:do\s+not|don't|dont|never|stop|cancel)[^,;:.!?\n]{0,24}(?:revise|edit|update|change|generate|export)/i
const ARTIFACT_REVISION_DISCUSSION = /^(?:为什么|为何|怎么|如何|请?(?:解释|说明|分析|讨论)|告诉我)[^。！？!?\n]{0,40}|(?:修改|编辑|调整|优化|改|换)[^。！？!?\n]{0,10}(?:是什么|什么意思|含义|原则|方法|逻辑|代码|工具)/i
const ARTIFACT_REPLACE_ORIGINAL_CUE = /(?:原地(?:修改|编辑|更新|覆盖)|(?:修改|编辑|更新|覆盖|改动?|调整)(?:原版|原文件|原文档|原表格|原演示|当前文件|当前版本|上一版)|(?:在|基于)(?:原版|原文件|当前文件|当前版本|上一版)(?:上|中|直接)?(?:修改|编辑|更新|覆盖|改动?|调整)|直接覆盖(?:原版|原文件|当前文件|上一版)|(?:edit|update|modify|overwrite)\s+(?:the\s+)?(?:original|existing|same)\s+(?:file|artifact|document|deck|workbook|page)|in[ -]?place)/i
const ARTIFACT_CREATE_COPY_CUE = /(?:(?:新建|另建|另做|另生成|另外生成|重新创建)(?:一|1)?(?:个|份)?(?:新)?(?:文件|版本|副本)?|(?:创建|生成|制作)(?:一|1)?(?:个|份)?新(?:文件|版本|副本)|另存为|(?:create|make|save)\s+(?:a\s+)?(?:new|separate)\s+(?:file|copy|version))/i
const ARTIFACT_CREATE_COPY_DENIAL = /(?:(?:不要|别|无需)(?:再)?(?:新建|另建|另做|新生成|创建新(?:文件|版本|副本))|without\s+creating\s+(?:a\s+)?new\s+(?:file|copy))/gi
const ARTIFACT_REPLACE_ORIGINAL_DENIAL = /(?:(?:保留|不改|不要修改|不要覆盖)(?:原版|原文件|当前文件|上一版)|keep\s+(?:the\s+)?original)/gi
const ARTIFACT_FILENAME_PRESERVATION = /(?:(?:保留|保持|维持|不改|不修改|别修改|不要修改|不要更改|不要改变|别更改|别改变)\s*(?:(?:原|当前)\s*)?文件\s*(?:名(?:称)?|的\s*(?:文件\s*)?名(?:称)?)|(?:keep|preserve|retain|do\s+not\s+change|don't\s+change|dont\s+change)\s+(?:the\s+)?(?:(?:original|existing|same|current)\s+)?(?:file\s*name|filename))/gi
const CODE_SNIPPET_DENIAL = /(?:不要|别|无需|不用|禁止|避免)[^。！？!?\n]{0,24}(?:代码|源码|code|source)|(?:do\s+not|don't|dont|never|without)[^.!?\n]{0,24}(?:code|source)/i
const EXPLICIT_CODE_SNIPPET_REQUEST = /(?:代码片段|源码片段|示例代码|完整代码|完整源码|(?:html|css|javascript|typescript|python|java|c\+\+|sql)\s*(?:代码|源码)|\bcode\s+snippet\b|\bfull\s+source(?:\s+code)?\b)|(?:给我|输出|提供|展示|贴出|发我|返回|生成|写出)[^。！？!?\n]{0,20}(?:代码|源码)|(?:show|provide|print|paste|return|write|give\s+me)[^.!?\n]{0,20}(?:code|source)/i

export function resolveArtifactRevisionMode(prompt = '') {
  const text = String(prompt || '').trim()
  if (!text) return 'unspecified'
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const preserveFilename = ARTIFACT_FILENAME_PRESERVATION.test(text)
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const dispositionText = text.replace(ARTIFACT_FILENAME_PRESERVATION, ' ')
  ARTIFACT_CREATE_COPY_DENIAL.lastIndex = 0
  ARTIFACT_REPLACE_ORIGINAL_DENIAL.lastIndex = 0
  const createCopyDenied = ARTIFACT_CREATE_COPY_DENIAL.test(dispositionText)
  const replaceOriginalDenied = ARTIFACT_REPLACE_ORIGINAL_DENIAL.test(dispositionText)
  ARTIFACT_CREATE_COPY_DENIAL.lastIndex = 0
  ARTIFACT_REPLACE_ORIGINAL_DENIAL.lastIndex = 0
  const createCopy = replaceOriginalDenied
    || ARTIFACT_CREATE_COPY_CUE.test(dispositionText.replace(ARTIFACT_CREATE_COPY_DENIAL, ''))
  const replaceOriginal = createCopyDenied
    || ARTIFACT_REPLACE_ORIGINAL_CUE.test(dispositionText.replace(ARTIFACT_REPLACE_ORIGINAL_DENIAL, ''))
    || (preserveFilename && !createCopy)
  if (replaceOriginal && createCopy) return 'conflict'
  if (replaceOriginal) return 'replace_original'
  if (createCopy) return 'create_copy'
  return 'unspecified'
}

export function isExplicitCodeSnippetRequest(prompt = '') {
  const text = String(prompt || '').trim()
  return Boolean(
    text
      && !CODE_SNIPPET_DENIAL.test(text)
      && EXPLICIT_CODE_SNIPPET_REQUEST.test(text),
  )
}

export function isArtifactRevisionRequest(prompt = '') {
  const text = String(prompt || '').trim()
  if (!text
    || GLOBAL_DENIAL.test(text)
    || ARTIFACT_REVISION_DENIAL.test(text)
    || ARTIFACT_REVISION_DISCUSSION.test(text)) return false
  return ARTIFACT_REVISION_ACTION.test(text)
    || resolveArtifactRevisionMode(text) !== 'unspecified'
}

function normalizePriorArtifactTypes(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase().replace(/^\./, ''))
    .map((value) => value === 'ppt' ? 'pptx' : value === 'doc' ? 'docx' : value === 'xls' ? 'xlsx' : value)
    .filter((value) => Object.hasOwn(ARTIFACT_TERMS, value)))
}

export function parseArtifactSkillId(prompt = '') {
  const match = String(prompt || '').trim().match(SKILL_PREFIX)
  return match ? canonicalizeSkillId(match[1]) : null
}

function occurrenceIsExplicitRequest(text, match) {
  const before = text.slice(Math.max(0, match.index - 48), match.index)
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 32)
  const identifierPrefix = text.slice(Math.max(0, match.index - 16), match.index)

  if (/(?:create|generate)[_-]$/i.test(identifierPrefix)) return false
  if (/^(?:报告|report)$/i.test(match[0])
    && RESULT_REPORT_OBJECT.test(after)
    && !ARTIFACT_PRODUCTION_BEFORE.test(before)) return false
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

export function detectArtifactIntent(prompt = '', { skillId = undefined, priorArtifactTypes = [] } = {}) {
  const text = String(prompt || '')
  const resolvedSkill = skillId === undefined ? parseArtifactSkillId(text) : skillId
  const skillTool = resolvedSkill ? resolveArtifactToolForSkillId(resolvedSkill) : null
  const explicitPptx = hasExplicitArtifactRequest(text, 'pptx')
  const explicitDocx = hasExplicitArtifactRequest(text, 'docx')
  const explicitXlsx = hasExplicitArtifactRequest(text, 'xlsx')
  const explicitHtml = hasExplicitArtifactRequest(text, 'html')
  const explicitPdf = hasExplicitArtifactRequest(text, 'pdf')
  const explicitImage = hasExplicitArtifactRequest(text, 'image')
  const allowAdditionalFormat = (type) => Boolean(
    ADDITIONAL_ARTIFACT_CUE.test(text)
      && STRONG_ARTIFACT_FORMAT[type]?.test(text)
      && hasExplicitArtifactRequest(text, type),
  )
  const pptx = skillTool === 'create_pptx' || (skillTool ? allowAdditionalFormat('pptx') : explicitPptx)
  const explicitAny = Boolean(skillTool || explicitPptx || explicitDocx || explicitXlsx || explicitHtml || explicitPdf || explicitImage)
  const inherited = !explicitAny && isArtifactRevisionRequest(text)
    ? normalizePriorArtifactTypes(priorArtifactTypes)
    : new Set()
  return {
    pptx: pptx || inherited.has('pptx'),
    // "PPT report" / "PPT 汇报" describes the deck's purpose; it is not a
    // second Word deliverable. Once PPT intent is explicit, require both a
    // multi-deliverable cue and a strong Word/DOCX term before adding DOCX.
    docx: skillTool === 'create_docx'
      || (skillTool
        ? allowAdditionalFormat('docx')
        : explicitDocx && (!pptx || allowAdditionalFormat('docx'))) || inherited.has('docx'),
    xlsx: skillTool === 'create_xlsx' || (skillTool ? allowAdditionalFormat('xlsx') : explicitXlsx) || inherited.has('xlsx'),
    html: skillTool === 'create_html_app' || (skillTool ? allowAdditionalFormat('html') : explicitHtml) || inherited.has('html'),
    pdf: skillTool === 'create_pdf' || (skillTool ? allowAdditionalFormat('pdf') : explicitPdf) || inherited.has('pdf'),
    image: skillTool === 'generate_image' || (skillTool ? allowAdditionalFormat('image') : explicitImage) || inherited.has('image'),
  }
}
