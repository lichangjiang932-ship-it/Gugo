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

/** Page/section options. Wrapper off: the iframe already provides the frame. */
export const DOCX_PREVIEW_OPTIONS = Object.freeze({
  inWrapper: false,
  breakPages: true,
  renderHeaders: true,
  renderFooters: true,
  useBase64URL: true,
  ignoreWidth: false,
  ignoreHeight: false,
  ignoreFonts: false,
  ignoreLastRenderedPageBreak: false,
  className: 'docx',
})

const BASE_CSS = [
  'html,body{margin:0;padding:0;background:transparent}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
  // No hard-coded page colour: the frame sits on the app surface, so leaving
  // the sections transparent keeps light/dark theming correct and avoids
  // inventing a colour that only matches one theme.
  '.docx{margin:0 auto 12px}',
].join('')

/**
 * Serialize a rendered DOCX body and its stylesheet into one self-contained
 * document. Styles and body share a single `<style>` because the document's own
 * rules must precede the markup they style.
 */
export function buildDocxSrcdoc({ bodyHtml = '', styleText = '', title = '' } = {}) {
  const safeTitle = String(title || '').replace(/[<>&]/gu, '')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${DOCX_PREVIEW_CSP}">`,
    `<title>${safeTitle}</title>`,
    `<style>${BASE_CSS}${String(styleText || '')}</style>`,
    '</head><body>',
    String(bodyHtml || ''),
    '</body></html>',
  ].join('')
}
