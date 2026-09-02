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

const CODE_SNIPPET_DENIAL = /(?:不要|别|无需|不用|禁止|避免)[^。！？!?\n]{0,24}(?:代码|源码|code|source)|(?:do\s+not|don't|dont|never|without)[^.!?\n]{0,24}(?:code|source)/i
const EXPLICIT_CODE_SNIPPET_REQUEST = /(?:代码片段|源码片段|示例代码|完整代码|完整源码|(?:html|css|javascript|typescript|python|java|c\+\+|sql)\s*(?:代码|源码)|\bcode\s+snippet\b|\bfull\s+source(?:\s+code)?\b)|(?:给我|输出|提供|展示|贴出|发我|返回|生成|写出)[^。！？!?\n]{0,20}(?:代码|源码)|(?:show|provide|print|paste|return|write|give\s+me)[^.!?\n]{0,20}(?:code|source)/i
const PDF_TO_IMAGE_CONVERSION = /(?:\b(?:convert|render|export)\b[^。！？!?;\n]{0,64}\bpdf\b[^。！？!?;\n]{0,32}\b(?:to|into|as)\b[^。！？!?;\n]{0,24}\b(?:images?|pictures?|png|jpe?g|webp)\b|(?:把|将)?[^。！？!?；;\n]{0,24}(?:pdf|\.pdf)[^。！？!?；;\n]{0,24}(?:转(?:换)?(?:成|为)|导出(?:成|为)|渲染(?:成|为)|生成)[^。！？!?；;\n]{0,16}(?:图片|图像|png|jpe?g|webp))/i

export const ARTIFACT_TERMS = Object.freeze({
  pptx: /\bpptx?\b|\.pptx?\b|power\s*point|幻灯片|演示文稿|演示稿|路演稿|slide\s*deck|\bslides?\b/gi,
  docx: /\bdocx?\b|\.docx?\b|\bword\b|word\s*文档|文档|报告|会议纪要|纪要|周报|合同|简历|document|report|minutes/gi,
  xlsx: /\bxlsx?\b|\.xlsx?\b|\bexcel\b|工作簿|电子表格|spread\s*sheet/gi,
  html: /\bhtml?\b|\.html?\b|\bweb\s*page\b|\bwebsite\b|\blanding\s*page\b|网页|网站|落地页/gi,
  pdf: /\bpdf\b|\.pdf\b|便携式文档/gi,
  image: /\bimages?\b|\bpictures?\b|\bphotos?\b|\billustrations?\b|\bposters?\b|\blogos?\b|\bmarketing\s+(?:images?|graphics?|art)\b|\bcover\s+art\b|\bhero\s+art\b|\u56fe\u7247|\u56fe\u50cf|\u63d2\u56fe|\u63d2\u753b|\u914d\u56fe|\u6d77\u62a5|\u8425\u9500\u56fe|\u5ba3\u4f20\u56fe|\u5e7f\u544a\u56fe|\u5c01\u9762\u56fe|\u5fbd\u6807|(?:\u54c1\u724c)?\u6807\u5fd7/gi,
})

const ARTIFACT_TYPE_BY_EXTENSION = Object.freeze({
  ppt: 'pptx',
  pptx: 'pptx',
  doc: 'docx',
  docx: 'docx',
  xls: 'xlsx',
  xlsx: 'xlsx',
  htm: 'html',
  html: 'html',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
})
const ARTIFACT_TYPE_ORDER = Object.freeze(Object.keys(ARTIFACT_TERMS))
const FILE_TARGET_REFERENCE = /(?:[a-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[^\s"'`“”‘’<>|?*，。；：！？（）()\u005b\u005d【】{}\\/]+[\\/])*[^\s"'`“”‘’<>|?*，。；：！？（）()\u005b\u005d【】{}\\/]+\.(?:pptx?|docx?|xlsx?|html?|pdf|png|jpe?g|webp|gif|svg)(?=$|[\s"'`“”‘’<>（）()\u005b\u005d【】{},;:，。；：！？])/giu
const REMOTE_URL_REFERENCE = /\b(?:https?|ftp):\/\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu
const LEADING_FILE_ACTION = /^(?:(?:请|帮我|麻烦|给我|直接|继续|把|将|再|重新)\s*)*(?:新建|创建|生成|制作|导出|修改|编辑|更新|覆盖|打开|读取|检查)\s*/iu
export const SKILL_PREFIX = /^\/([a-z0-9_-]+)(?:\s|$)/i

export const ARTIFACT_DELIVERY_TARGETS = Object.freeze({
  WORKSPACE_FILE: 'workspace_file',
  MANAGED_ARTIFACT: 'managed_artifact',
  MIXED: 'mixed',
  STANDALONE: 'standalone',
})

function maskRemoteUrlReferences(prompt = '') {
  REMOTE_URL_REFERENCE.lastIndex = 0
  const masked = String(prompt || '').replace(REMOTE_URL_REFERENCE, (url) => ' '.repeat(url.length))
  REMOTE_URL_REFERENCE.lastIndex = 0
  return masked
}

export function stripRemoteUrlReferences(prompt = '') {
  REMOTE_URL_REFERENCE.lastIndex = 0
  const stripped = String(prompt || '').replace(REMOTE_URL_REFERENCE, ' ')
  REMOTE_URL_REFERENCE.lastIndex = 0
  return stripped
}

function normalizeFileTargetPath(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withoutAction = /[\\/]/.test(raw) || /^[a-z]:/i.test(raw)
    ? raw
    : raw.replace(LEADING_FILE_ACTION, '')
  return withoutAction.trim()
}

function fileTargetType(path = '') {
  const match = String(path || '').match(/\.([a-z0-9]+)$/i)
  return match ? ARTIFACT_TYPE_BY_EXTENSION[match[1].toLowerCase()] || null : null
}

export function extractFileTargetReferences(prompt = '') {
  const text = maskRemoteUrlReferences(prompt)
  FILE_TARGET_REFERENCE.lastIndex = 0
  const references = []
  const seen = new Set()
  for (const match of text.matchAll(FILE_TARGET_REFERENCE)) {
    const path = normalizeFileTargetPath(match[0])
    const type = fileTargetType(path)
    if (!path || !type) continue
    const normalized = path.replace(/\\/g, '/').toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    references.push({
      path,
      filename: path.split(/[\\/]/).pop() || path,
      type,
      index: match.index,
      length: match[0].length,
      raw: match[0],
    })
  }
  FILE_TARGET_REFERENCE.lastIndex = 0
  return { text, references }
}

export function typeForArtifactTool(toolName = '') {
  return Object.entries({
    pptx: 'create_pptx',
    docx: 'create_docx',
    xlsx: 'create_xlsx',
    html: 'create_html_app',
    pdf: 'create_pdf',
    image: 'generate_image',
  }).find(([, tool]) => tool === toolName)?.[0] || null
}

export function filenameEquals(left = '', right = '') {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
}

export function intentTypes(intent = {}) {
  return ARTIFACT_TYPE_ORDER.filter((type) => intent?.[type] === true)
}

export function isExplicitCodeSnippetRequest(prompt = '') {
  const text = String(prompt || '').trim()
  return Boolean(
    text
      && !CODE_SNIPPET_DENIAL.test(text)
      && EXPLICIT_CODE_SNIPPET_REQUEST.test(text),
  )
}

export function isPdfToImageConversionRequest(prompt = '') {
  return PDF_TO_IMAGE_CONVERSION.test(String(prompt || ''))
}

export function parseArtifactSkillId(prompt = '') {
  const match = String(prompt || '').trim().match(SKILL_PREFIX)
  return match ? canonicalizeSkillId(match[1]) : null
}
