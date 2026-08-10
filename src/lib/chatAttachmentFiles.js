const MAX_TEXT_BYTES = 256 * 1024

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('Could not read image.'))
    reader.readAsDataURL(file)
  })
}

export function dataUrlByteLength(dataUrl = '') {
  const comma = String(dataUrl).indexOf(',')
  const payload = comma >= 0 ? String(dataUrl).slice(comma + 1) : String(dataUrl)
  return Math.floor((payload.length * 3) / 4)
}

export function getClipboardFiles(clipboardData) {
  const itemFiles = Array.from(clipboardData?.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile?.())
    .filter(Boolean)
  const fallbackFiles = Array.from(clipboardData?.files || []).filter(Boolean)
  if (!itemFiles.length) return fallbackFiles
  if (!fallbackFiles.length) return itemFiles

  const identity = (file) => [file.name, file.type, file.size, file.lastModified]
    .map((value) => String(value ?? ''))
    .join('\0')
  const represented = new Map()
  for (const file of itemFiles) {
    const key = identity(file)
    represented.set(key, (represented.get(key) || 0) + 1)
  }
  const merged = [...itemFiles]
  for (const file of fallbackFiles) {
    const key = identity(file)
    const remaining = represented.get(key) || 0
    if (remaining > 0) {
      represented.set(key, remaining - 1)
    } else {
      merged.push(file)
    }
  }
  return merged
}

export function getClipboardImageFiles(clipboardData) {
  return getClipboardFiles(clipboardData)
    .filter((file) => String(file.type || '').startsWith('image/'))
}

export function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

export function isTextLikeFile(file) {
  return /^text\/|json|xml|csv|markdown|javascript|typescript/.test(file.type) ||
    /\.(txt|md|json|csv|xml|yml|yaml|log|js|jsx|ts|tsx|css|html)$/i.test(file.name)
}

export function isExcelFile(file) {
  return /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(file.name)
}

export async function readExcelAsText(file) {
  const XLSX = await import('@e965/xlsx')
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })
  const parts = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    parts.push(`[Sheet: ${sheetName}]\n${csv}`)
  }
  return parts.join('\n\n')
}

export function clampTextToBytes(text, label = 'Content too long') {
  const value = String(text ?? '')
  if (new TextEncoder().encode(value).length <= MAX_TEXT_BYTES) return value
  const maxChars = Math.floor(MAX_TEXT_BYTES / 2)
  return `${value.slice(0, maxChars)}\n\n[${label}, truncated]`
}
