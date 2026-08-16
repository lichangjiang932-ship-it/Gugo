const HTML_ARTIFACT_DIRECTIVES = Object.freeze([
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "worker-src 'none'",
  "manifest-src 'none'",
])

export const HTML_ARTIFACT_DOCUMENT_CSP = HTML_ARTIFACT_DIRECTIVES.join('; ')
export const HTML_ARTIFACT_RESPONSE_CSP = `sandbox allow-scripts; frame-ancestors 'self'; ${HTML_ARTIFACT_DOCUMENT_CSP}`

/**
 * srcDoc does not inherit the CSP response header used to fetch its source.
 * Put the policy before any artifact markup so nothing can run first.
 */
export function applyHtmlArtifactDocumentPolicy(source = '') {
  const html = String(source).replace(/^\uFEFF/, '')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_DOCUMENT_CSP}">`
  const doctype = html.match(/^\s*<!doctype\s+html[^>]*>/i)
  if (!doctype) return `${meta}\n${html}`
  return `${doctype[0]}\n${meta}\n${html.slice(doctype[0].length)}`
}
