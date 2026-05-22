/**
 * pptCore — 三套 PPT 通路（server/artifactGen / src/lib/presentationExport / src/lib/htmlSlidesToPptx）
 * 共享的 isomorphic 工具：字体常量、premium themes、east-asia 字体注入、bullet 规范化、escapeXml。
 *
 * 不放进来的:
 *   - layout 渲染函数（每条通路目标不同：HTML deck vs 真 pptxgenjs vs 截图 overlay）
 *   - presentationExport 的 warm/tech/finance/consumer themes（语义不同——前端是亮色 deck）
 *
 * 设计原则：
 *   - 零 Node-only API（jszip 是同构的，浏览器/Node 都能用）
 *   - 只导出常量和纯函数，不持有状态
 */

/* ── 字体（跨端安全） ── */
export const HEAD_FONT = 'Calibri'
export const BODY_FONT = 'Calibri'
export const CJK_FONT = 'Microsoft YaHei'

/* ── 16:9 宽屏（inches） ── */
export const SLIDE_W = 13.333
export const SLIDE_H = 7.5

/* ── Premium themes（暗色为主，给 server-side tool_call 用） ── */
export const PREMIUM_THEMES = {
  noir: {
    bg: '0E1014', panel: '171A21', card: '1C2029',
    text: 'ECEEF1', soft: 'A8AEB8', muted: '5C636E',
    accent: 'D4A574', accentSoft: '7BA7B5', line: '2A2F38',
  },
  paper: {
    bg: 'F5F1E8', panel: 'EAE3D2', card: 'FFFFFF',
    text: '20180F', soft: '4A3E2E', muted: '8A7B68',
    accent: 'B5532A', accentSoft: '3F6E76', line: 'D6CCB6',
  },
  ocean: {
    bg: '0B1A2A', panel: '11253A', card: '163149',
    text: 'E8EEF5', soft: 'A4B5C7', muted: '5A6B7E',
    accent: 'D8B255', accentSoft: '6FA8B0', line: '24344A',
  },
  forest: {
    bg: '0F1A14', panel: '162621', card: '1D3128',
    text: 'EAEFE8', soft: 'A6B5A7', muted: '5A6C5D',
    accent: 'C1A35A', accentSoft: '6FA890', line: '243329',
  },
}

export function resolvePremiumTheme(seed = '') {
  const text = String(seed || '').toLowerCase()
  if (/bank|finance|fund|insurance|wealth|金融|银行|保险|基金|投研|财务|consulting|咨询/.test(text)) return PREMIUM_THEMES.ocean
  if (/esg|green|carbon|health|medical|biology|环保|医疗|生物|可持续/.test(text)) return PREMIUM_THEMES.forest
  if (/journal|writing|brand|notion|文档|品牌|出版|杂志|手册|写作/.test(text)) return PREMIUM_THEMES.paper
  return PREMIUM_THEMES.noir
}

/* ── XML 转义（DOCX/XLSX/theme 注入用） ── */
export function escapeXml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/* ── Bullet 规范化（截断 + 限数）── */
export const BULLET_MAX_CHARS = 60
export const BULLETS_PER_PAGE = 5

export function normalizeBullets(slide = {}, { maxChars = BULLET_MAX_CHARS, maxItems = BULLETS_PER_PAGE } = {}) {
  let bullets = Array.isArray(slide.bullets) ? slide.bullets : []
  if (!bullets.length && slide.body) {
    bullets = String(slide.body).split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, '').trim())
  }
  return bullets
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .map((b) => (b.length > maxChars ? `${b.slice(0, maxChars - 1)}…` : b))
    .slice(0, maxItems)
}

/* ── East-Asia 字体注入（让 theme1.xml 写 Microsoft YaHei） ──
 * 参数: pptxBytes (Uint8Array | Buffer | ArrayBuffer)
 * 返回: Uint8Array (同构友好)
 * 失败时返回原 buffer，绝不抛错（这是 finishing touch，不能因为它把整个 PPT 干废）
 */
export async function injectEaFont(pptxBytes, eaFont = CJK_FONT) {
  try {
    // jszip 是同构的，在 Node 和浏览器都能 import
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(pptxBytes)
    const themeFile = zip.file('ppt/theme/theme1.xml')
    if (!themeFile) return toUint8Array(pptxBytes)
    let xml = await themeFile.async('string')
    const eaTag = `<a:ea typeface="${escapeXml(eaFont)}"/>`
    const inject = (inner) =>
      inner.includes('<a:ea')
        ? inner.replace(/<a:ea[^/]*\/>/, eaTag)
        : inner.replace(/(<a:latin[^/]*\/>)/, `$1${eaTag}`)
    xml = xml.replace(/<a:majorFont>([\s\S]*?)<\/a:majorFont>/, (_, inner) => `<a:majorFont>${inject(inner)}</a:majorFont>`)
    xml = xml.replace(/<a:minorFont>([\s\S]*?)<\/a:minorFont>/, (_, inner) => `<a:minorFont>${inject(inner)}</a:minorFont>`)
    zip.file('ppt/theme/theme1.xml', xml)
    return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  } catch {
    return toUint8Array(pptxBytes)
  }
}

function toUint8Array(b) {
  if (b instanceof Uint8Array) return b
  if (b instanceof ArrayBuffer) return new Uint8Array(b)
  const BufferCtor = globalThis.Buffer
  if (BufferCtor?.isBuffer?.(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  return new Uint8Array(b)
}

/* ── pptxgenjs ShapeType 兜底（不同版本字段大小写不同）── */
export function shape(pptx, name) {
  return pptx?.ShapeType?.[name] || name
}
