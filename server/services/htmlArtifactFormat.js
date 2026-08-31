import { htmlArtifactAssetIds } from './htmlArtifactAssets.js'
import {
  htmlPreviewRemoteImageOrigins,
  maskAllowedHtmlPreviewRemoteImages,
} from './htmlPreviewRemoteImagePolicy.js'

export const MAX_HTML_ARTIFACT_BYTES = 2 * 1024 * 1024

const HTML_FENCE = /^\s*```(?:html)?\s*([\s\S]*?)\s*```\s*$/i
const HTML_LOCAL_RESOURCE_REFERENCE = /(?:\b(?:src|poster)\s*=\s*["']\s*|\burl\s*\(\s*["']?\s*|["'`])(?:file:\/\/{0,2}|[a-z]:[\\/]|\\\\[^\\\s"'`]+\\)/i
const HTML_REMOTE_RESOURCE_REFERENCE = /(?:\b(?:src|srcset|poster|data|background)\s*=\s*["']?\s*|\burl\s*\(\s*["']?\s*|@import\s+(?:url\s*\(\s*)?["']?\s*)(?:https?:|wss?:|ftp:|\/\/)/i
const HTML_REMOTE_LINK_REFERENCE = /<(?:link|base)\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:|wss?:|ftp:|\/\/)/i
const HTML_FORM_SUBMISSION = /<(?:form\b[^>]*\baction|(?:button|input)\b[^>]*\bformaction)\s*=/i
const HTML_META_REFRESH = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/i
const HTML_NETWORK_API_CALL = /(?:\b(?:fetch|sendBeacon)\s*\(|\[\s*["'](?:fetch|sendBeacon)["']\s*\]\s*\(|\b(?:new\s+)?(?:XMLHttpRequest|WebSocket|EventSource|WebTransport)\s*\()/i
const HTML_DELIVERY_INSTRUCTION_PATTERNS = Object.freeze([
  /(?:网页|页面|html)(?:\s*代码)?(?:已经|已)?(?:生成|完成|准备好)|(?:html|webpage|page)(?:\s+code)?\s+(?:is\s+)?(?:ready|generated|complete)/i,
  /(?:复制|拷贝)[^。！？\n]{0,48}(?:代码|源码)|copy[^.!?\n]{0,48}(?:code|source)/i,
  /(?:新建|创建)[^。！？\n]{0,32}(?:文件|\.html)|create[^.!?\n]{0,32}(?:file|\.html)/i,
  /(?:粘贴|貼上)[^。！？\n]{0,32}(?:保存|存储)|(?:保存|另存)[^。！？\n]{0,48}(?:\.html|html\s*文件)|paste[^.!?\n]{0,32}save|save[^.!?\n]{0,48}(?:\.html|as\s+html)/i,
  /(?:双击|浏览器)[^。！？\n]{0,48}(?:打开|预览)|(?:double[- ]?click|open)[^.!?\n]{0,48}(?:browser|locally)/i,
])

function normalizeHtmlArtifactSource(value) {
  const raw = String(value || '')
  const fenced = raw.match(HTML_FENCE)
  return (fenced ? fenced[1] : raw).trim()
}

function visibleHtmlText(source) {
  return String(source || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function assertHtmlIsPageContent(source) {
  const visibleText = visibleHtmlText(source)
  const instructionSignals = HTML_DELIVERY_INSTRUCTION_PATTERNS
    .filter((pattern) => pattern.test(visibleText))
    .length
  const structuralTags = (source.match(/<(?:h[1-6]|main|section|article|nav|header|footer|form|button|input|select|textarea|canvas|svg|table|ul|ol|li|img|video|audio|p)\b/gi) || []).length
  const looksLikeShortHandoff = visibleText.length <= 2_000 && structuralTags <= 3 && instructionSignals >= 2
  if (instructionSignals >= 4 || looksLikeShortHandoff) {
    throw new Error('html contains file-delivery instructions instead of the requested webpage content')
  }
}

export function validateHtmlArtifactSource(source, {
  assetIds = [],
  remoteImageOrigins = htmlPreviewRemoteImageOrigins(),
} = {}) {
  const html = normalizeHtmlArtifactSource(source)
  if (!html) throw new Error('html is required')
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_ARTIFACT_BYTES) {
    throw new Error('html artifact exceeds the 2 MB limit')
  }
  if (!/<(?:!doctype\s+html|html|head|body|main|section)\b/i.test(html)) {
    throw new Error('html must contain a complete HTML document')
  }
  if (/attachment:\/\//i.test(html)) {
    throw new Error('html artifact contains an unresolved attachment URI')
  }
  if (HTML_LOCAL_RESOURCE_REFERENCE.test(html)) {
    throw new Error('html artifact cannot reference a local disk path; declare the file in assets and use gugo-asset://<id>')
  }
  const declaredAssetIds = new Set(
    Array.isArray(assetIds)
      ? assetIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  )
  const referencedAssetIds = new Set(htmlArtifactAssetIds(html))
  for (const id of referencedAssetIds) {
    if (!declaredAssetIds.has(id)) {
      throw new Error(`html artifact references undeclared managed asset: ${id}`)
    }
  }
  for (const id of declaredAssetIds) {
    if (!referencedAssetIds.has(id)) {
      throw new Error(`html artifact declares an unused managed asset: ${id}`)
    }
  }
  const networkValidationSource = maskAllowedHtmlPreviewRemoteImages(html, remoteImageOrigins)
  const blocked = [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=/i,
    /<iframe\b/i,
    HTML_REMOTE_RESOURCE_REFERENCE,
    HTML_REMOTE_LINK_REFERENCE,
    HTML_FORM_SUBMISSION,
    HTML_META_REFRESH,
    HTML_NETWORK_API_CALL,
    /javascript\s*:/i,
  ]
  if (blocked.some((pattern) => pattern.test(networkValidationSource))) {
    throw new Error('html artifact must be self-contained and cannot load external scripts, styles, frames, or network requests')
  }
  assertHtmlIsPageContent(html)
  return html
}

function inlineHtmlFiles(files = {}) {
  const index = files && typeof files === 'object' ? files['index.html'] : ''
  let html = normalizeHtmlArtifactSource(index)
  const css = String(files?.['styles.css'] || '').trim()
  const js = String(files?.['app.js'] || '').trim()
  if (css) {
    const style = `<style>\n${css}\n</style>`
    html = /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${style}\n</head>`) : `${style}\n${html}`
  }
  if (js) {
    const script = `<script>\n${js}\n</script>`
    html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}\n</body>`) : `${html}\n${script}`
  }
  return html
}

export function resolveHtmlArtifactSource({ html, files, assetIds = [] } = {}) {
  return validateHtmlArtifactSource(html || inlineHtmlFiles(files), { assetIds })
}
