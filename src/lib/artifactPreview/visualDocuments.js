import { escapeHtml, stripDangerousMarkup } from './previewSanitizers.js'

const MERMAID_LIBRARY_URL = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'
const CHART_LIBRARY_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'

function validatedPreviewNonce(options = {}) {
  const nonce = String(options?.nonce || '').trim()
  return nonce && /^[A-Za-z0-9+/_=-]+$/.test(nonce) ? nonce : ''
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nonceOwnedExternalScript(documentHtml, marker, src, nonce) {
  const pattern = new RegExp(
    `<script(?:\\s+nonce="[^"]*")?\\s+data-yma-preview-script="${escapeRegExp(marker)}"\\s+src="${escapeRegExp(src)}"><\\/script>`,
    'gi',
  )
  return documentHtml.replace(
    pattern,
    `<script nonce="${nonce}" data-yma-preview-script="${marker}" src="${src}"></script>`,
  )
}

function nonceOwnedInlineScript(documentHtml, marker, nonce, isOwnedBody) {
  const pattern = new RegExp(
    `<script(?:\\s+nonce="[^"]*")?\\s+data-yma-preview-script="${escapeRegExp(marker)}">([\\s\\S]*?)<\\/script>`,
    'gi',
  )
  return documentHtml.replace(pattern, (match, body) => (
    isOwnedBody(body)
      ? `<script nonce="${nonce}" data-yma-preview-script="${marker}">${body}</script>`
      : match
  ))
}

function isOwnedMermaidInitializer(body) {
  return /^mermaid\.initialize\(\{startOnLoad:true,theme:"(?:default|neutral|dark|forest|base)",securityLevel:'strict'\}\);$/.test(body)
}

function isOwnedChartInitializer(body) {
  const match = String(body).trim().match(
    /^const config = ([\s\S]+);\s*new Chart\(document\.getElementById\('chart'\), config\);$/,
  )
  if (!match) return false
  try {
    JSON.parse(match[1])
    return true
  } catch {
    return false
  }
}

export function applyVisualPreviewScriptNonces(documentHtml = '', options = {}) {
  const doc = String(documentHtml || '')
  const nonce = validatedPreviewNonce(options)
  const previewType = String(options?.previewType || '')
  if (!doc || !nonce) return doc
  if (previewType === 'mermaid') {
    const withLibrary = nonceOwnedExternalScript(
      doc,
      'mermaid-library',
      MERMAID_LIBRARY_URL,
      nonce,
    )
    return nonceOwnedInlineScript(
      withLibrary,
      'mermaid-init',
      nonce,
      isOwnedMermaidInitializer,
    )
  }
  if (previewType === 'chart') {
    const withLibrary = nonceOwnedExternalScript(
      doc,
      'chart-library',
      CHART_LIBRARY_URL,
      nonce,
    )
    return nonceOwnedInlineScript(withLibrary, 'chart-init', nonce, isOwnedChartInitializer)
  }
  return doc
}

export function buildMermaidDocument(diagram = '', theme = 'default') {
  const safeDiagram = escapeHtml(diagram)
  const safeTheme = ['default', 'neutral', 'dark', 'forest', 'base'].includes(theme) ? theme : 'default'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script data-yma-preview-script="mermaid-library" src="${MERMAID_LIBRARY_URL}"></script>
<style>
html,body{margin:0;min-height:100%;background:radial-gradient(circle at top left,#fff7ed,#eef2ff 42%,#f8fafc);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827}
.wrap{min-height:100vh;display:grid;place-items:center;padding:32px}
.card{width:min(1080px,100%);border:1px solid rgba(17,24,39,.12);border-radius:24px;background:rgba(255,255,255,.78);box-shadow:0 24px 80px rgba(15,23,42,.14);backdrop-filter:blur(16px);padding:28px;overflow:auto}
</style>
</head>
<body>
<div class="wrap"><div class="card"><pre class="mermaid">${safeDiagram}</pre></div></div>
<script data-yma-preview-script="mermaid-init">mermaid.initialize({startOnLoad:true,theme:${JSON.stringify(safeTheme)},securityLevel:'strict'});</script>
</body>
</html>`
}

export function buildChartDocument(configSource = '') {
  const config = (() => {
    try { return typeof configSource === 'string' ? JSON.parse(configSource) : configSource }
    catch { return {} }
  })()
  const safeConfig = JSON.stringify(config).replace(/<\/script>/gi, '<\\/script>')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script data-yma-preview-script="chart-library" src="${CHART_LIBRARY_URL}"></script>
<style>
html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#0f172a,#312e81 45%,#7c2d12);color:white}
.wrap{height:100%;display:grid;place-items:center;padding:32px;box-sizing:border-box}
.card{width:min(980px,100%);height:min(640px,82vh);padding:28px;border-radius:28px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 30px 90px rgba(0,0,0,.35);backdrop-filter:blur(18px)}
</style>
</head>
<body>
<div class="wrap"><div class="card"><canvas id="chart"></canvas></div></div>
<script data-yma-preview-script="chart-init">
const config = ${safeConfig};
new Chart(document.getElementById('chart'), config);
</script>
</body>
</html>`
}

export function buildSvgDocument(svgSource = '') {
  const svg = stripDangerousMarkup(svgSource)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
html,body{margin:0;height:100%;background:conic-gradient(from 180deg at 50% 50%,#fff7ed,#f1f5f9,#eef2ff,#fff7ed);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{height:100%;display:grid;place-items:center;padding:28px;box-sizing:border-box}
.card{max-width:min(1000px,92vw);max-height:84vh;border-radius:28px;background:rgba(255,255,255,.82);border:1px solid rgba(15,23,42,.12);box-shadow:0 24px 80px rgba(15,23,42,.16);padding:28px;overflow:auto}
svg{max-width:100%;height:auto;display:block}
</style>
</head>
<body><div class="wrap"><div class="card">${svg}</div></div></body>
</html>`
}
