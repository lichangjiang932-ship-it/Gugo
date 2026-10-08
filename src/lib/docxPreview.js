/**
 * Faithful DOCX preview: render the original package instead of re-authoring it.
 *
 * The previous preview parsed the document into paragraphs and re-emitted them as
 * markdown-ish blocks, which flattened tables, dropped merged cells, borders and
 * embedded images, and collapsed explicit page breaks. That is a summary, not a
 * preview, and users correctly reported it as "the table disappeared".
 *
 * `docx-preview` renders the real OOXML into DOM, so the preview keeps the
 * document's own tables, spans, borders, images, styles and page sections. The
 * result is serialized into a *sandboxed* iframe with a `default-src 'none'`
 * CSP so a hostile document cannot phone home: images are inlined as data URLs
 * (`useBase64URL`) precisely so nothing needs to be fetched at render time.
 */
export const DOCX_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src data:",
].join('; ')

/**
 * Page/section options. Wrapper off: the iframe already provides the frame.
 *
 * Each section keeps the document's own page width (`ignoreWidth` off), so a
 * page looks like the page Word prints; the frame then scales the whole page to
 * the pane (`buildDocxSrcdoc`'s `scale`) instead of reflowing it, the way the
 * reference desktop apps show a document at "70%" in a narrow panel.
 * `ignoreHeight` stays on: a page's minimum height would pad a short document
 * with a tall empty block. Page breaks still come from `breakPages`.
 */
export const DOCX_PREVIEW_OPTIONS = Object.freeze({
  inWrapper: false,
  breakPages: true,
  renderHeaders: true,
  renderFooters: true,
  useBase64URL: true,
  ignoreWidth: false,
  ignoreHeight: true,
  ignoreFonts: false,
  ignoreLastRenderedPageBreak: false,
  className: 'docx',
})

/** A4 at 96 dpi, for a document that declares no page size. */
export const DOCX_DEFAULT_PAGE_WIDTH_PX = 794

const UNIT_PX = Object.freeze({ px: 1, pt: 96 / 72, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 })

/** The widest page width the rendered sections declare, in CSS pixels. */
export function docxPageWidthPx(container) {
  const sections = container?.querySelectorAll?.('section.docx') || []
  let widest = 0
  for (const section of sections) {
    const match = /^([\d.]+)(px|pt|in|cm|mm)$/u.exec(String(section.style?.width || '').trim())
    if (match) widest = Math.max(widest, Number(match[1]) * UNIT_PX[match[2]])
  }
  return widest > 0 ? Math.round(widest) : DOCX_DEFAULT_PAGE_WIDTH_PX
}

const BASE_CSS = [
  'html,body{margin:0;padding:0}',
  'body{padding:16px 0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
  'section.docx{margin:0 auto 16px;box-sizing:border-box;background:#fff;color:#111;box-shadow:0 1px 3px rgba(0,0,0,.12),0 6px 18px -6px rgba(0,0,0,.18)}',
  'section.docx:last-child{margin-bottom:0}',
  '.docx img,.docx svg{max-width:100%;height:auto}',
].join('')

/**
 * The desk the pages sit on, like a word processor's reading view; pages stay
 * white because a document's own colours assume paper. The desk follows the
 * app theme it is given, not the OS colour scheme: the sandboxed frame cannot
 * see the parent's html[data-theme].
 */
const DESK_BACKGROUND = Object.freeze({ light: '#eceef1', dark: '#26282c' })

/**
 * Serialize a rendered DOCX body and its stylesheet into one self-contained
 * document. Styles and body share a single `<style>` because the document's own
 * rules must precede the markup they style. `scale` zooms the pages as a whole
 * (layout included, so the frame scrolls the scaled height); `theme` is the
 * app theme, 'light' or 'dark'.
 */
export function buildDocxSrcdoc({ bodyHtml = '', styleText = '', title = '', scale = 1, theme = 'light' } = {}) {
  const safeTitle = String(title || '').replace(/[<>&]/gu, '')
  const desk = theme === 'dark' ? DESK_BACKGROUND.dark : DESK_BACKGROUND.light
  const zoom = Number.isFinite(scale) && scale > 0 ? Math.round(scale * 1000) / 1000 : 1
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOCX_PREVIEW_CSP}">`,
    `<title>${safeTitle}</title>`,
    `<style>${BASE_CSS}html{background:${desk}}${zoom === 1 ? '' : `body{zoom:${zoom}}`}${String(styleText || '')}</style>`,
    '</head><body>',
    String(bodyHtml || ''),
    '</body></html>',
  ].join('')
}
