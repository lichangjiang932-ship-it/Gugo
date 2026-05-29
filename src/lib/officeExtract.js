// 客户端 Office 文本提取 —— DOCX / PPTX 都是 zip 容器，正文存在内部 XML 里。
// 之前 handleFileChange 把这些类型直接当成不可读的 kind:'file'，模型只拿到文件名，
// 造成"上传文件只有名称没有内容"。这里用项目已依赖的 jszip 把可见文本抽出来。

const MAX_OFFICE_TEXT_CHARS = 120_000

function xmlUnescape(value = '') {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&') // 必须最后，避免把 &amp;lt; 二次解码
}

// 收集某个 XML 片段里所有 <ns:t ...>文本</ns:t>（w:t for docx, a:t for pptx）。
function collectRunText(xml, tagName) {
  const parts = []
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g')
  let match
  while ((match = re.exec(xml)) !== null) {
    parts.push(xmlUnescape(match[1]))
  }
  return parts.join('')
}

// 把 XML 按段落标签拆开，每段内部聚合 run 文本，再用换行连接。
function extractParagraphs(xml, paragraphTag, runTag) {
  const normalized = String(xml)
    .replace(/<[^:>]*:tab\b[^>]*\/?>/g, '\t')
    .replace(/<[^:>]*:br\b[^>]*\/?>/g, '\n')
  const blocks = normalized.split(new RegExp(`</${paragraphTag}>`))
  const lines = []
  for (const block of blocks) {
    const text = collectRunText(block, runTag).replace(/[ \t]+\n/g, '\n').trimEnd()
    if (text.trim()) lines.push(text)
  }
  return lines.join('\n')
}

async function loadZip(file) {
  const module = await import('jszip')
  const JSZip = module.default || module
  const buffer = await file.arrayBuffer()
  return JSZip.loadAsync(buffer)
}

export async function extractDocxText(file, { maxChars = MAX_OFFICE_TEXT_CHARS } = {}) {
  const zip = await loadZip(file)
  const doc = zip.file('word/document.xml')
  if (!doc) {
    return `[DOCX 附件: ${file.name}。未找到 word/document.xml，可能不是标准 .docx。]`
  }
  const xml = await doc.async('string')
  const text = extractParagraphs(xml, 'w:p', 'w:t').slice(0, maxChars)
  return text || `[DOCX 附件: ${file.name}。文档为空或仅含图片，未提取到文本。]`
}

export async function extractPptxText(file, { maxChars = MAX_OFFICE_TEXT_CHARS } = {}) {
  const zip = await loadZip(file)
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)[1])
      const nb = Number(b.match(/slide(\d+)\.xml$/)[1])
      return na - nb
    })
  if (!slideFiles.length) {
    return `[PPTX 附件: ${file.name}。未找到幻灯片 XML，可能不是标准 .pptx。]`
  }
  const parts = []
  let index = 0
  for (const name of slideFiles) {
    index += 1
    const xml = await zip.files[name].async('string')
    const slideText = extractParagraphs(xml, 'a:p', 'a:t').trim()
    if (slideText) parts.push(`[幻灯片 ${index}]\n${slideText}`)
  }
  const text = parts.join('\n\n').slice(0, maxChars)
  return text || `[PPTX 附件: ${file.name}。未提取到文本（可能全是图片）。]`
}

export function isDocxFile(file) {
  return /\.docx$/i.test(file?.name || '') ||
    file?.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

export function isPptxFile(file) {
  return /\.pptx$/i.test(file?.name || '') ||
    file?.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
