const MAX_PDF_TEXT_CHARS = 120_000

function decodePdfString(value = '') {
  return String(value)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

/**
 * Lightweight client-side PDF text sniffing.
 *
 * It is intentionally dependency-free: many local PDFs store visible text in
 * literal strings or hex strings. Scanned PDFs still fall back to a bounded
 * metadata note, but the attachment stays safe and usable instead of becoming
 * an opaque binary blob.
 */
export async function extractPdfText(file, { maxChars = MAX_PDF_TEXT_CHARS } = {}) {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }

  const parts = []
  for (const match of binary.matchAll(/\(([^()]{2,2000})\)\s*Tj/g)) {
    parts.push(decodePdfString(match[1]))
  }
  for (const match of binary.matchAll(/\(([^()]{2,1000})\)/g)) {
    if (parts.length > 300) break
    parts.push(decodePdfString(match[1]))
  }

  const text = parts
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part && /[\p{L}\p{N}]/u.test(part))
    .join('\n')
    .slice(0, maxChars)

  if (text) return text
  return `[PDF attachment: ${file.name}. Text could not be extracted locally; it may be scanned or compressed.]`
}
