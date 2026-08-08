const TEXT_PREVIEW_LIMIT = 4 * 1024 * 1024
const OFFICE_PREVIEW_LIMIT = 64 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'less', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'vue', 'svelte',
  'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'log',
])
const TEXT_EXTENSIONS = new Set(['txt', 'rtf', ...CODE_EXTENSIONS])

export function directFileExtension(file = {}) {
  const filename = String(file.filename || file.title || '')
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,12})$/)
  return match?.[1] || ''
}

export function classifyDirectFile(file = {}) {
  const extension = directFileExtension(file)
  const mime = String(file.mimeType || file.type || '').toLowerCase()
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (extension === 'docx' || mime.includes('wordprocessingml')) return 'docx'
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(extension) || mime.includes('spreadsheet') || mime.includes('excel')) return 'xlsx'
  if (['pptx', 'pptm'].includes(extension) || mime.includes('presentationml')) return 'pptx'
  if (['html', 'htm'].includes(extension) || mime.includes('text/html')) return 'html'
  if (MARKDOWN_EXTENSIONS.has(extension) || mime.includes('markdown')) return 'markdown'
  if (extension === 'json' || mime.includes('json')) return 'json'
  if (extension === 'xml' || mime.includes('xml')) return 'xml'
  if (['csv', 'tsv'].includes(extension) || mime.includes('csv') || mime.includes('tab-separated')) return 'csv'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension) || mime.startsWith('text/')) return 'text'
  return 'unsupported'
}

export function withArtifactPreviewMode(value = '') {
  const url = String(value || '')
  if (!url) return ''
  const hashIndex = url.indexOf('#')
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  return `${base}${base.includes('?') ? '&' : '?'}preview=1${hash}`
}

function xmlUnescape(value = '') {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&amp;/g, '&')
}

function collectXmlText(xml, tagName) {
  const text = []
  const expression = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g')
  let match
  while ((match = expression.exec(xml)) !== null) text.push(xmlUnescape(match[1]))
  return text.join('')
}

async function loadZip(input) {
  const module = await import('jszip')
  const JSZip = module.default || module
  return JSZip.loadAsync(input)
}

export async function parseDocxPreview(input, filename = 'document.docx') {
  const zip = await loadZip(input)
  const document = zip.file('word/document.xml')
  if (!document) throw new Error('Invalid DOCX: word/document.xml is missing')
  const xml = await document.async('string')
  const blocks = []
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []
  for (const paragraph of paragraphs) {
    const normalized = paragraph
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    const text = collectXmlText(normalized, 'w:t').trim()
    if (!text) continue
    const style = paragraph.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i)?.[1] || ''
    const heading = /^(?:title|heading\s*[1-6]|heading[1-6])$/i.test(style)
    blocks.push({ type: heading ? 'heading' : /<w:numPr\b/i.test(paragraph) ? 'bullet' : 'paragraph', text, style })
  }
  const fallbackTitle = String(filename).replace(/\.docx$/i, '') || 'Document'
  let title = fallbackTitle
  if (blocks[0]?.type === 'heading' && /^(?:title|heading\s*1|heading1)$/i.test(blocks[0].style)) {
    title = blocks.shift().text
  }
  return { title, blocks: blocks.map(({ type, text }) => ({ type, text })) }
}

export async function parsePptxPreview(input, filename = 'presentation.pptx') {
  const zip = await loadZip(input)
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/i)?.[1]) - Number(right.match(/slide(\d+)/i)?.[1]))
  if (!names.length) throw new Error('Invalid PPTX: no slides were found')
  const slides = []
  for (const name of names) {
    const xml = await zip.files[name].async('string')
    const paragraphs = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || []
    const lines = paragraphs.map((paragraph) => collectXmlText(paragraph, 'a:t').trim()).filter(Boolean)
    slides.push({ title: lines[0] || `Slide ${slides.length + 1}`, lines: lines.slice(1) })
  }
  const title = String(filename).replace(/\.pptx?$/i, '') || slides[0]?.title || 'Presentation'
  const content = slides.map((slide, index) => [
    index === 0 ? `# ${title}` : `## ${slide.title}`,
    index === 0 && slide.title !== title ? `## ${slide.title}` : '',
    ...slide.lines.map((line) => `- ${line}`),
  ].filter(Boolean).join('\n\n')).join('\n\n---\n\n')
  return { title, slides, content }
}

export async function parseXlsxPreview(input) {
  const module = await import('@e965/xlsx')
  const XLSX = module.default || module
  const workbook = XLSX.read(new Uint8Array(input), { type: 'array' })
  const sheets = workbook.SheetNames.slice(0, 24).map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    }).slice(0, 2_000).map((row) => row.slice(0, 100).map((cell) => String(cell ?? ''))),
  }))
  if (!sheets.length) throw new Error('Invalid spreadsheet: no worksheets were found')
  return { sheets }
}

export function parseDelimitedPreview(text, delimiter = ',') {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const input = String(text || '')
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      row.push(cell); rows.push(row); row = []; cell = ''
      if (rows.length >= 2_000) break
    } else cell += char
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.map((cells) => cells.slice(0, 100))
}

function assertPreviewSize(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('File is too large to preview safely')
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '')
}

export async function loadDirectFilePreview({ file = {}, url = '', fetchImpl = fetch } = {}) {
  const kind = classifyDirectFile(file)
  if (['pdf', 'image', 'audio', 'video', 'unsupported'].includes(kind)) return { kind, url }
  const response = await fetchImpl(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Could not load file preview (${response.status})`)
  const office = ['docx', 'xlsx', 'pptx'].includes(kind)
  assertPreviewSize(response, office ? OFFICE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > (office ? OFFICE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT)) throw new Error('File is too large to preview safely')
  if (kind === 'docx') return { kind, ...(await parseDocxPreview(buffer, file.filename || file.title)) }
  if (kind === 'xlsx') return { kind, ...(await parseXlsxPreview(buffer)) }
  if (kind === 'pptx') return { kind, ...(await parsePptxPreview(buffer, file.filename || file.title)) }
  let text = decodeText(buffer)
  if (kind === 'json') {
    try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* show the original invalid JSON */ }
  }
  if (kind === 'csv') {
    const delimiter = directFileExtension(file) === 'tsv' ? '\t' : ','
    return { kind, text, rows: parseDelimitedPreview(text, delimiter) }
  }
  return { kind, text, html: kind === 'html' ? text : undefined }
}
