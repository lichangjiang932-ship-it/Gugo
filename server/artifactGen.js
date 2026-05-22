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

const PPTX_THEMES = {
  tech: { bg: '0B0D12', panel: '151B2E', card: '1E293B', text: 'E6E8EE', soft: 'AAB3C5', muted: '667085', accent: '6366F1', accent2: 'EC4899', line: '334155' },
  finance: { bg: '0D1812', panel: '14251C', card: '1D3228', text: 'E8EFE6', soft: 'B9CABB', muted: '6B806F', accent: '10B981', accent2: 'FBBF24', line: '315141' },
  consumer: { bg: 'FEF8F4', panel: 'FFF1E8', card: 'FFFFFF', text: '1F2937', soft: '4B5563', muted: '9CA3AF', accent: 'FB7185', accent2: 'F59E0B', line: 'FED7AA' },
  warm: { bg: '1A1612', panel: '251E18', card: '30261E', text: 'F5ECD9', soft: 'D6C4A7', muted: '907F67', accent: 'D4A574', accent2: '8B2929', line: '514235' },
}

function resolvePptxTheme(seed = '') {
  const text = String(seed || '').toLowerCase()
  if (/ai|saas|software|cloud|tech|digital|智能|科技|算法|平台|模型/.test(text)) return PPTX_THEMES.tech
  if (/bank|finance|fund|insurance|wealth|金融|银行|保险|基金|投研|财务/.test(text)) return PPTX_THEMES.finance
  if (/consumer|brand|retail|beauty|food|fashion|消费|品牌|零售|美妆|餐饮/.test(text)) return PPTX_THEMES.consumer
  return PPTX_THEMES.warm
}

function getBullets(slide = {}) {
  const bullets = Array.isArray(slide.bullets) ? slide.bullets : []
  if (bullets.length) return bullets.map((b) => String(b)).filter(Boolean).slice(0, 6)
  if (slide.body) return String(slide.body).split(/\n+/).map((line) => line.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 6)
  return []
}

function shape(pptx, name) {
  return pptx.ShapeType?.[name] || name
}

function addDeckDecor(slide, pptx, theme, index) {
  slide.background = { color: theme.bg }
  slide.addShape(shape(pptx, 'rect'), {
    x: 0, y: 0, w: 13.333, h: 7.5,
    fill: { color: theme.bg },
    line: { color: theme.bg, width: 0 },
  })
  slide.addShape(shape(pptx, 'ellipse'), {
    x: index % 2 === 0 ? 10.2 : -1.4, y: index % 2 === 0 ? -1.6 : 5.1, w: 4.2, h: 4.2,
    fill: { color: theme.accent, transparency: 78 },
    line: { color: theme.accent, width: 0 },
  })
  slide.addShape(shape(pptx, 'ellipse'), {
    x: index % 2 === 0 ? -1.0 : 10.7, y: index % 2 === 0 ? 5.3 : -1.0, w: 2.8, h: 2.8,
    fill: { color: theme.accent2, transparency: 84 },
    line: { color: theme.accent2, width: 0 },
  })
  slide.addShape(shape(pptx, 'rect'), {
    x: 0.48, y: 0.42, w: 1.1, h: 0.08,
    fill: { color: theme.accent },
    line: { color: theme.accent, width: 0 },
  })
}

function addDeckFooter(slide, theme, index, total) {
  slide.addShape('rect', {
    x: 0.65, y: 6.86, w: 10.2, h: 0.015,
    fill: { color: theme.line, transparency: 20 },
    line: { color: theme.line, width: 0 },
  })
  slide.addText(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, {
    x: 11.0, y: 6.7, w: 1.45, h: 0.22,
    fontSize: 9, color: theme.muted, align: 'right', margin: 0,
  })
}

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
  pptx.subject = title
  pptx.company = 'Your Model Atelier'
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'zh-CN',
  }

  const theme = resolvePptxTheme(`${title} ${slides.map((s) => s?.title || '').join(' ')}`)
  const total = slides.length

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] || {}
    const slide = pptx.addSlide()
    const titleText = String(s.title || `Slide ${i + 1}`)
    const bullets = getBullets(s)
    const layout = i === 0 ? 'cover' : i === total - 1 ? 'end' : ['cards', 'split', 'statement', 'content'][i % 4]

    addDeckDecor(slide, pptx, theme, i)

    if (layout === 'cover') {
      slide.addText(titleText, {
        x: 0.85, y: 1.85, w: 10.9, h: 1.4,
        fontFace: 'Aptos Display', fontSize: 44, bold: true, color: theme.text,
        margin: 0, breakLine: false, fit: 'shrink',
      })
      if (bullets[0]) {
        slide.addText(bullets[0], {
          x: 0.9, y: 3.38, w: 9.8, h: 0.45,
          fontFace: 'Aptos', fontSize: 18, color: theme.soft, margin: 0,
        })
      }
      slide.addText('YOUR MODEL ATELIER', {
        x: 0.9, y: 5.85, w: 3.6, h: 0.25,
        fontFace: 'Aptos', fontSize: 9, color: theme.muted, bold: true, charSpace: 2.2, margin: 0,
      })
      slide.addShape(shape(pptx, 'rect'), {
        x: 0.9, y: 4.28, w: 2.2, h: 0.055,
        fill: { color: theme.accent2 },
        line: { color: theme.accent2, width: 0 },
      })
    } else if (layout === 'cards') {
      slide.addText(titleText, {
        x: 0.72, y: 0.72, w: 11.3, h: 0.65,
        fontFace: 'Aptos Display', fontSize: 28, bold: true, color: theme.text, margin: 0, fit: 'shrink',
      })
      bullets.slice(0, 4).forEach((bullet, idx) => {
        const x = 0.72 + idx * 3.05
        slide.addShape(shape(pptx, 'roundRect'), {
          x, y: 2.0, w: 2.65, h: 2.9,
          rectRadius: 0.12,
          fill: { color: theme.card, transparency: 6 },
          line: { color: theme.line, transparency: 28, width: 0.7 },
        })
        slide.addText(String(idx + 1).padStart(2, '0'), {
          x: x + 0.22, y: 2.22, w: 0.7, h: 0.28,
          fontFace: 'Aptos Display', fontSize: 15, bold: true, color: idx % 2 ? theme.accent2 : theme.accent, margin: 0,
        })
        slide.addText(bullet, {
          x: x + 0.22, y: 2.82, w: 2.18, h: 1.2,
          fontFace: 'Aptos', fontSize: 15, color: theme.soft, margin: 0, breakLine: false, fit: 'shrink',
        })
      })
    } else if (layout === 'split') {
      slide.addText(titleText, {
        x: 0.72, y: 0.72, w: 11.3, h: 0.65,
        fontFace: 'Aptos Display', fontSize: 28, bold: true, color: theme.text, margin: 0, fit: 'shrink',
      })
      const left = bullets.slice(0, Math.ceil(bullets.length / 2))
      const right = bullets.slice(Math.ceil(bullets.length / 2))
      ;[
        { x: 0.75, items: left, accent: theme.accent, label: 'A' },
        { x: 6.85, items: right.length ? right : left.slice(0, 2), accent: theme.accent2, label: 'B' },
      ].forEach((panel) => {
        slide.addShape(shape(pptx, 'rect'), {
          x: panel.x, y: 1.72, w: 5.35, h: 4.6,
          fill: { color: theme.panel, transparency: 2 },
          line: { color: panel.accent, transparency: 35, width: 1.2 },
        })
        slide.addText(panel.label, {
          x: panel.x + 0.28, y: 1.98, w: 0.48, h: 0.36,
          fontFace: 'Aptos Display', fontSize: 17, bold: true, color: panel.accent, margin: 0,
        })
        if (panel.items.length) {
          slide.addText(panel.items.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 8 } })), {
            x: panel.x + 0.45, y: 2.55, w: 4.55, h: 3.2,
            fontFace: 'Aptos', fontSize: 15, color: theme.soft, fit: 'shrink',
          })
        }
      })
    } else if (layout === 'statement') {
      slide.addText(titleText, {
        x: 1.0, y: 1.55, w: 10.6, h: 1.35,
        fontFace: 'Aptos Display', fontSize: 34, bold: true, color: theme.text, align: 'center', margin: 0, fit: 'shrink',
      })
      slide.addShape(shape(pptx, 'rect'), {
        x: 5.35, y: 3.15, w: 2.6, h: 0.05,
        fill: { color: theme.accent },
        line: { color: theme.accent, width: 0 },
      })
      if (bullets.length) {
        slide.addText(bullets.slice(0, 3).join('  ·  '), {
          x: 1.55, y: 3.58, w: 10.2, h: 0.8,
          fontFace: 'Aptos', fontSize: 16, color: theme.soft, align: 'center', margin: 0, fit: 'shrink',
        })
      }
    } else {
      slide.addText(titleText, {
        x: 0.72, y: 0.72, w: 11.3, h: 0.65,
        fontFace: 'Aptos Display', fontSize: 28, bold: true, color: theme.text, margin: 0, fit: 'shrink',
      })
      if (bullets.length) {
        slide.addText(bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 12 } })), {
          x: 1.0, y: 1.75, w: 10.9, h: 4.55,
          fontFace: 'Aptos', fontSize: 18, color: theme.soft, fit: 'shrink',
        })
      }
    }

    addDeckFooter(slide, theme, i, total)
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
  if (artifact.userId !== userId) {
    // 不暴露存在性,统一 404
    res.statusCode = 404; res.end('not found'); return
  }

  ensureArtifactDir()
  let full = path.join(ARTIFACT_DIR, filename)
  // 防 path traversal (含 symlink)
  try {
    full = fs.realpathSync(full)
  } catch {
    res.statusCode = 404; res.end('not found'); return
  }
  if (!full.startsWith(fs.realpathSync(ARTIFACT_DIR) + path.sep)) { res.statusCode = 400; res.end('bad filename'); return }
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
  const stream = fs.createReadStream(full)
  stream.on('error', (err) => {
    console.error('[artifactGen] read stream error:', err?.message)
    if (!res.headersSent) {
      res.statusCode = 500; res.end('read error')
    }
  })
  stream.pipe(res)
}

export function getArtifactDir() {
  return ARTIFACT_DIR
}
