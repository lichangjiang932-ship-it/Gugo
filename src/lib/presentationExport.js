const MAX_BULLETS_PER_SLIDE = 8
const MAX_BULLET_LENGTH = 150
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

function stripMarkdownFence(markdown = '') {
  return String(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\n```\s*$/i, '')
    .trim()
}

function cleanTitle(line = '') {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d{1,2}[.、]\s*/, '')
    .replace(/^第[一二三四五六七八九十\d]+页[：:、.]?\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .trim()
}

function cleanBullet(line = '') {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d{1,2}[.、]\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
}

function chunkToSlide(lines) {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean)
  if (!cleaned.length) return null

  const title = cleanTitle(cleaned[0]) || '未命名页面'
  const bullets = cleaned
    .slice(1)
    .map(cleanBullet)
    .filter((line) => line && line !== '---')
    .filter((line) => !/^目录$/.test(line))
    .slice(0, MAX_BULLETS_PER_SLIDE)
    .map((line) => (line.length > MAX_BULLET_LENGTH ? `${line.slice(0, MAX_BULLET_LENGTH)}...` : line))

  return { title, bullets }
}

function parseSeparatedSlides(markdown) {
  return markdown
    .split(/^\s*---+\s*$/m)
    .map((part) => chunkToSlide(part.split('\n')))
    .filter(Boolean)
}

function parseNumberedOutline(markdown) {
  const lines = markdown.split('\n')
  const slides = []
  let preface = []
  let current = null

  const pushCurrent = () => {
    if (current) {
      const slide = chunkToSlide([current.title, ...current.lines])
      if (slide) slides.push(slide)
      current = null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const numbered = line.match(/^(?:#{1,4}\s*)?(\d{1,2})[.、]\s+(.+)$/)
    if (numbered) {
      if (!current && preface.length) {
        const titleSlide = chunkToSlide(preface.filter((item) => !/^\d{1,2}[.、]/.test(item)))
        if (titleSlide) slides.push(titleSlide)
        preface = []
      }
      pushCurrent()
      current = { title: numbered[2].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else preface.push(line)
  }

  pushCurrent()

  if (!slides.length && preface.length) {
    const slide = chunkToSlide(preface)
    if (slide) slides.push(slide)
  }

  return slides
}

export function parseMarkdownSlides(markdown) {
  const clean = stripMarkdownFence(markdown)
  if (!clean) return []
  const separatedSlides = parseSeparatedSlides(clean)
  if (separatedSlides.length > 1) return separatedSlides
  return parseNumberedOutline(clean)
}

export function shouldOfferPptxExport({ skillId, artifactType } = {}) {
  return skillId === 'ppt' || artifactType === 'pptx'
}

export function buildPresentationFilename(title = 'presentation') {
  const base = String(title)
    .replace(/\.pptx$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${base || 'presentation'}.pptx`
}

async function buildPresentationFromMarkdown(markdown, { title } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')

  const module = await import('pptxgenjs')
  const PptxGenJS = module.default || module
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Your Model Atelier'
  pptx.company = 'Your Model Atelier'
  pptx.subject = title || slides[0].title
  pptx.title = title || slides[0].title
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'zh-CN',
  }

  slides.forEach((slideData, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: 'F8F4EC' }
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.333,
      h: 0.18,
      fill: { color: index === 0 ? 'E86A3C' : '2E8FA3' },
      line: { color: index === 0 ? 'E86A3C' : '2E8FA3' },
    })
    slide.addText(slideData.title, {
      x: 0.75,
      y: index === 0 ? 1.15 : 0.6,
      w: 11.8,
      h: 0.8,
      fontFace: 'Aptos Display',
      fontSize: index === 0 ? 34 : 28,
      bold: true,
      color: '26211C',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
    })
    if (slideData.bullets.length) {
      slide.addText(slideData.bullets.map((bullet) => ({ text: bullet, options: { bullet: { type: 'bullet' } } })), {
        x: 0.95,
        y: index === 0 ? 2.35 : 1.65,
        w: 11.35,
        h: 4.7,
        fontFace: 'Aptos',
        fontSize: 18,
        color: '403A34',
        breakLine: false,
        fit: 'shrink',
        paraSpaceAfterPt: 10,
      })
    }
    slide.addText(`${index + 1} / ${slides.length}`, {
      x: 11.55,
      y: 7.05,
      w: 1,
      h: 0.22,
      fontSize: 9,
      color: '8A8178',
      align: 'right',
      margin: 0,
    })
  })

  return { pptx, slides }
}

function saveBlob(blob, filename) {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.dataset.interception = 'off'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 100)
}

export async function createPptxBlobFromMarkdown(markdown, { title } = {}) {
  const { pptx } = await buildPresentationFromMarkdown(markdown, { title })
  const content = await pptx.write({ outputType: 'blob' })
  if (content instanceof Blob && content.type === PPTX_MIME) return content
  return new Blob([content], { type: PPTX_MIME })
}

export async function downloadPptxFromMarkdown(markdown, { title, filename } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')

  const blob = await createPptxBlobFromMarkdown(markdown, { title: title || slides[0].title })
  saveBlob(blob, filename || buildPresentationFilename(title || slides[0].title))
  return blob
}
