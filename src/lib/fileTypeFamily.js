/**
 * Format families for file icons. The colours follow what each format's own
 * application uses, so a Word file reads as Word before its name is read.
 */
const FAMILIES = Object.freeze([
  { id: 'word', label: 'W', color: '#2b6bd6', extensions: ['doc', 'docx', 'odt', 'rtf'] },
  { id: 'slides', label: 'P', color: '#d9572b', extensions: ['ppt', 'pptx', 'odp', 'key'] },
  { id: 'sheet', label: 'X', color: '#1f8a4c', extensions: ['xls', 'xlsx', 'ods', 'csv', 'tsv'] },
  { id: 'pdf', label: 'PDF', color: '#d63b3b', extensions: ['pdf'] },
  { id: 'web', label: '</>', color: '#7a5af5', extensions: ['html', 'htm', 'svg', 'html_multi', 'mermaid', 'chart'] },
  { id: 'image', label: '', color: '#0f9fb5', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'] },
  { id: 'media', label: '▶', color: '#c2417a', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm', 'mov', 'mkv'] },
  { id: 'markdown', label: 'M', color: '#4b5563', extensions: ['md', 'markdown', 'mdx'] },
  { id: 'code', label: '{ }', color: '#b7791f', extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'ps1', 'json', 'xml', 'yaml', 'yml', 'toml', 'css', 'scss', 'sql', 'react'] },
])

export function fileTypeFamily(nameOrType = '') {
  const value = String(nameOrType || '').trim().toLowerCase()
  const extension = value.includes('.') ? value.split('.').pop() : value
  return FAMILIES.find((family) => family.extensions.includes(extension)) || null
}
