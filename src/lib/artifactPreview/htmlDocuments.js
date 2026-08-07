import { enhanceHtmlDeckDocument, enhanceHtmlPreviewReadability } from './htmlDeckEnhancer.js'
import { stripDangerousMarkup } from './previewSanitizers.js'

export function buildHtmlDocument(htmlSource = '') {
  const src = String(htmlSource || '').trim()
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(src)) {
    return enhanceHtmlDeckDocument(enhanceHtmlPreviewReadability(src))
  }
  return enhanceHtmlDeckDocument(enhanceHtmlPreviewReadability(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>\u9884\u89c8</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;color:#26211C;background:#F8F4EC;line-height:1.6}</style>
</head>
<body>
${src}
</body>
</html>`))
}

export function parseMultiHtmlSource(source = '') {
  if (source && typeof source === 'object') return source
  try {
    const parsed = JSON.parse(String(source || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { 'index.html': String(source || '') }
  }
}

export function buildMultiHtmlDocument(source = '') {
  const files = parseMultiHtmlSource(source)
  const index = stripDangerousMarkup(files['index.html'] || '')
  const css = Object.entries(files)
    .filter(([name]) => /\.css$/i.test(name))
    .map(([, content]) => String(content || ''))
    .join('\n\n')
  const js = Object.entries(files)
    .filter(([name]) => /\.js$/i.test(name))
    .map(([, content]) => String(content || '').replace(/<\/script>/gi, '<\\/script>'))
    .join('\n;\n')

  let html = index || '<main id="app"></main>'
  if (css) {
    html = html.includes('</head>')
      ? html.replace('</head>', `<style>${css}</style></head>`)
      : `<style>${css}</style>${html}`
  }
  if (js) {
    html = html.includes('</body>')
      ? html.replace('</body>', `<script>${js}</script></body>`)
      : `${html}<script>${js}</script>`
  }
  return buildHtmlDocument(html)
}
