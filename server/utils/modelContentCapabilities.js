const MAX_PDF_FALLBACK_CHARS = 256 * 1024

function safePdfFilename(value = '') {
  const name = String(value || '').trim().replace(/[\r\n]/g, ' ')
  return name.slice(0, 240) || 'attachment.pdf'
}

function isPdfDataUrl(value = '') {
  return /^data:application\/pdf(?:;[^,]*)?,/i.test(String(value || ''))
}

function pdfFallbackText(part = {}) {
  const fallback = String(part.fallback_text || '').trim().slice(0, MAX_PDF_FALLBACK_CHARS)
  if (fallback) return fallback
  return `[PDF attachment: ${safePdfFilename(part.filename)}. No extractable text was available.]`
}

/**
 * `yma_pdf` 是浏览器与模型代理之间的内部内容块，绝不能原样发给上游。
 * 支持原生 PDF 的端点收到 OpenAI Chat Completions 的 file 块；其余端点收到
 * 浏览器已提取的有界文本。这样 provider failover 时也能按候选端点重新选择。
 */
export function normalizeModelContentForEndpoint(messages = [], profile = {}) {
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    const content = message.content.map((part) => {
      if (part?.type !== 'yma_pdf') return part
      if (profile.supportsPdf && isPdfDataUrl(part.file_data)) {
        return {
          type: 'file',
          file: {
            filename: safePdfFilename(part.filename),
            file_data: String(part.file_data),
          },
        }
      }
      return { type: 'text', text: pdfFallbackText(part) }
    })
    return { ...message, content }
  })
}
