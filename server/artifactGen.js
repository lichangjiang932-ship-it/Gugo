/**
 * G1: 服务端真实生成 PPT/Word/Excel — 模型 tool_call → 服务端 zip → 返回下载链接.
 *
 * 设计:
 *   - 三种产物全部用 jszip 手写 Office Open XML(零额外依赖,docx/xlsx 不引外部库)
 *   - PPT 走 pptxgenjs(已是 dep),它已经能 output 'nodebuffer'
 *   - 产物落到 process.env.ARTIFACT_DIR (默认 ./.artifacts/),返回相对 url
 *     /api/artifacts/<id>.<ext>;前端 RightPreviewPane 直接挂 <a href=...>
 *
 * MVP 范围:
 *   - create_pptx({ title, slides: [{ title, bullets[] }] })   → .pptx
 *   - create_docx({ title, paragraphs: string[] | { heading?, text }[] }) → .docx
 *   - create_xlsx({ title, sheets: [{ name, rows: string[][] }] }) → .xlsx
 *
 * 不做(留下一轮):图表 / 图片 / 多 sheet 复杂样式 / 字体内嵌
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import JSZip from 'jszip'
import { authenticateRequest } from './middleware.js'
import { getArtifactByFilename } from './jobStore.js'

const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR && path.isAbsolute(process.env.ARTIFACT_DIR)
    ? process.env.ARTIFACT_DIR
    : path.resolve(process.cwd(), process.env.ARTIFACT_DIR || '.artifacts')

function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  return ARTIFACT_DIR
}

function newArtifactPath(ext) {
  ensureArtifactDir()
  const id = crypto.randomBytes(8).toString('hex')
  const filename = `${Date.now()}-${id}.${ext}`
  return { id, filename, fullPath: path.join(ARTIFACT_DIR, filename), url: `/api/artifacts/${filename}` }
}

function escapeXml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/* ────────────────────────── PPTX ────────────────────────── */

export async function createPptx({ title = 'Presentation', slides = [] } = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides 不能为空')
  }
  const PptxGen = (await import('pptxgenjs')).default
  const pptx = new PptxGen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = title
  pptx.author = 'Your Model Atelier'
  pptx.lang = 'zh-CN'

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] || {}
    const slide = pptx.addSlide()
    slide.background = { color: 'F8F4EC' }
    slide.addShape('rect', {
      x: 0, y: 0, w: 13.333, h: 0.18,
      fill: { color: i === 0 ? 'E86A3C' : '2E8FA3' },
      line: { color: i === 0 ? 'E86A3C' : '2E8FA3' },
    })
    slide.addText(String(s.title || `Slide ${i + 1}`), {
      x: 0.75, y: i === 0 ? 1.15 : 0.6, w: 11.8, h: 0.8,
      fontSize: i === 0 ? 34 : 28, bold: true, color: '26211C', fit: 'shrink',
    })
    const bullets = Array.isArray(s.bullets) ? s.bullets : []
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: { type: 'bullet' } } })),
        { x: 0.95, y: i === 0 ? 2.35 : 1.65, w: 11.35, h: 4.7, fontSize: 18, color: '403A34', paraSpaceAfterPt: 10, fit: 'shrink' },
      )
    }
    slide.addText(`${i + 1} / ${slides.length}`, {
      x: 11.55, y: 7.05, w: 1, h: 0.22, fontSize: 9, color: '8A8178', align: 'right',
    })
  }
  const buffer = await pptx.write({ outputType: 'nodebuffer' })
  const a = newArtifactPath('pptx')
  fs.writeFileSync(a.fullPath, buffer)
  return { ...a, type: 'pptx', title, slideCount: slides.length, byteLength: buffer.length }
}

/* ────────────────────────── DOCX ────────────────────────── */

function buildDocxParagraphsXml(paragraphs) {
  // 接受 string 或 { heading?: 1|2|3, text }
  const out = []
  for (const p of paragraphs) {
    if (!p) continue
    const isObj = typeof p === 'object'
    const text = escapeXml(isObj ? (p.text || '') : String(p))
    const heading = isObj ? Number(p.heading) || 0 : 0
    if (heading >= 1 && heading <= 3) {
      out.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`,
      )
    } else {
      out.push(`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    }
  }
  return out.join('')
}

export async function createDocx({ title = 'Document', paragraphs = [] } = {}) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    throw new Error('paragraphs 不能为空')
  }
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  )
  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )
  const word = zip.folder('word')
  word.folder('_rels').file(
    'document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  )
  word.file(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`,
  )
  // 标题作为第一段 H1
  const allParagraphs = [{ heading: 1, text: title }, ...paragraphs]
  word.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${buildDocxParagraphsXml(allParagraphs)}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`,
  )
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const a = newArtifactPath('docx')
  fs.writeFileSync(a.fullPath, buffer)
  return { ...a, type: 'docx', title, paragraphCount: paragraphs.length, byteLength: buffer.length }
}

/* ────────────────────────── XLSX ────────────────────────── */

function colLetter(i) {
  // 0 → A, 25 → Z, 26 → AA
  let n = i, s = ''
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

function buildSheetXml(rows) {
  const lines = []
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || []
    const cells = []
    for (let c = 0; c < row.length; c++) {
      const ref = `${colLetter(c)}${r + 1}`
      const raw = row[c]
      if (raw == null || raw === '') continue
      // 数字直接 n,其他走 inlineStr
      if (typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw))) {
        cells.push(`<c r="${ref}"><v>${raw}</v></c>`)
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`)
      }
    }
    lines.push(`<row r="${r + 1}">${cells.join('')}</row>`)
  }
  return lines.join('')
}

export async function createXlsx({ title = 'Spreadsheet', sheets = [] } = {}) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('sheets 不能为空')
  }
  const validSheets = sheets
    .map((s, i) => ({
      name: String(s?.name || `Sheet${i + 1}`).slice(0, 31).replace(/[\\/?*[\]]/g, '_'),
      rows: Array.isArray(s?.rows) ? s.rows : [],
    }))
    .filter((s) => s.rows.length > 0)
  if (!validSheets.length) throw new Error('至少要有一个非空 sheet')

  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${validSheets.map((_, i) => `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
  )
  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  )
  const xl = zip.folder('xl')
  xl.folder('_rels').file(
    'workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${validSheets.map((_, i) => `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`,
  )
  xl.file(
    'workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${validSheets.map((s, i) => `    <sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
  </sheets>
</workbook>`,
  )
  const ws = xl.folder('worksheets')
  validSheets.forEach((s, i) => {
    ws.file(
      `sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${buildSheetXml(s.rows)}</sheetData>
</worksheet>`,
    )
  })

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const a = newArtifactPath('xlsx')
  fs.writeFileSync(a.fullPath, buffer)
  const totalRows = validSheets.reduce((sum, s) => sum + s.rows.length, 0)
  return { ...a, type: 'xlsx', title, sheetCount: validSheets.length, rowCount: totalRows, byteLength: buffer.length }
}

/* ────────────────────────── 静态服务 ────────────────────────── */

const SAFE_NAME = /^[\w.-]+\.(pptx|docx|xlsx)$/

export function handleArtifactDownload(req, res) {
  const url = req.url || ''
  const m = url.match(/^\/api\/artifacts\/([^?#]+)/)
  if (!m) { res.statusCode = 404; res.end('not found'); return }
  const filename = decodeURIComponent(m[1])
  if (!SAFE_NAME.test(filename)) { res.statusCode = 400; res.end('bad filename'); return }

  // 鉴权:Header 优先,query token 兜底(浏览器 <a> 下载没法带 Authorization 头)
  let userId = authenticateRequest(req)
  if (!userId) {
    const u = new URL(req.url, 'http://localhost')
    const queryToken = u.searchParams.get('token')
    if (queryToken) {
      req.headers.authorization = `Bearer ${queryToken}`
      userId = authenticateRequest(req)
    }
  }
  if (!userId) { res.statusCode = 401; res.end('Unauthorized'); return }

  // Ownership:artifact 的 user_id 必须匹配
  const artifact = getArtifactByFilename(filename)
  if (!artifact) { res.statusCode = 404; res.end('not found'); return }
  if (artifact.userId && artifact.userId !== userId) {
    // 不暴露存在性,统一 404
    res.statusCode = 404; res.end('not found'); return
  }

  ensureArtifactDir()
  const full = path.join(ARTIFACT_DIR, filename)
  // 防 path traversal
  if (!full.startsWith(ARTIFACT_DIR + path.sep)) { res.statusCode = 400; res.end('bad filename'); return }
  if (!fs.existsSync(full)) { res.statusCode = 404; res.end('not found'); return }
  const ext = path.extname(filename).slice(1)
  const ct =
    ext === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  res.writeHead(200, {
    'Content-Type': ct,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': fs.statSync(full).size,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(full).pipe(res)
}

export function getArtifactDir() {
  return ARTIFACT_DIR
}
