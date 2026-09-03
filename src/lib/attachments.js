import { normalizeProductLanguage } from '../../shared/productLanguage.js'

export function formatAttachmentForPrompt(attachment) {
  if (attachment.kind === 'text' || attachment.kind === 'pdf') {
    return `\n\n[附件: ${attachment.name}, ${attachment.sizeKB} KB]\n\`\`\`\n${attachment.text}\n\`\`\``
  }
  const ext = attachment.name.split('.').pop()?.toLowerCase()
  const binaryTypes = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'zip', 'epub', 'rtf']
  const note = binaryTypes.includes(ext) ? '（二进制文件，无法直接读取内容）' : ''
  return `\n\n[附件: ${attachment.name}, ${attachment.sizeKB} KB, 类型: ${attachment.type || 'unknown'}${note}]`
}

export function buildUserContentWithAttachments(prompt, attachments = []) {
  const textAttachments = attachments
    .filter((item) => item.kind !== 'image' && item.kind !== 'pdf')
    .map(formatAttachmentForPrompt)
    .join('')
  const text = `${prompt || '请分析附件内容。'}${textAttachments}`
  const images = attachments.filter((item) => item.kind === 'image' && item.dataUrl)
  const pdfs = attachments.filter((item) => item.kind === 'pdf')
  if (!images.length && !pdfs.length) return text
  return [
    { type: 'text', text },
    ...images.map((item) => ({
      type: 'image_url',
      image_url: { url: item.dataUrl },
    })),
    ...pdfs.map((item) => ({
      type: 'yma_pdf',
      filename: item.name,
      file_data: item.dataUrl,
      fallback_text: formatAttachmentForPrompt(item).trim(),
    })),
  ]
}

export function describeAttachmentPrompt(attachments = [], locale = 'zh') {
  if (!attachments.length) return ''
  const language = normalizeProductLanguage(locale)
  const names = attachments
    .map((item) => item.name)
    .filter(Boolean)
    .slice(0, 4)
    .join(language === 'zh' ? '、' : ', ')
  if (language === 'zh') {
    const suffix = attachments.length > 4 ? ` 等 ${attachments.length} 个附件` : ''
    return `请分析附件：${names}${suffix}`
  }
  const suffix = attachments.length > 4 ? ` and ${attachments.length - 4} more` : ''
  return `Please analyze the attached files: ${names}${suffix}`
}

export function buildUserDisplayContent(prompt, attachments = []) {
  const content = typeof prompt === 'string' ? prompt : String(prompt || '')
  const items = Array.isArray(attachments) ? attachments : []
  if (!items.length) return content
  const labels = items.map((item) => {
    const name = String(item?.name || 'attachment')
    const size = Number.isFinite(Number(item?.sizeKB)) ? Number(item.sizeKB) : 0
    return `[\u9644\u4ef6: ${name}, ${size} KB]`
  }).join('\n')
  return content ? `${content}\n\n${labels}` : labels
}
