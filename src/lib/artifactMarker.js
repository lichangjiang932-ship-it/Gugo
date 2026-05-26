/**
 * artifactMarker · 从 markdown 文本里提取可打开的 artifact 链接.
 *
 * 触发形式 (两种, 都要安全):
 *   1. 裸 marker:   [report-2026.pptx]            → 文件名当作 .artifacts/ 下的产物名
 *   2. link marker: [我的周报](deck-abc.pptx)      → 第二段也走同一白名单
 *
 * 安全规则 (Lens 2 防 prompt injection):
 *   - 后缀必须 ∈ {pptx, pdf, md, docx, xlsx}
 *   - 不允许绝对路径 (开头 /), 不允许 ..
 *   - 长度 ≤ 200
 *   - 只允许 [A-Za-z0-9._\-\u4e00-\u9fa5/] 子集 (中文文件名可)
 *   - 链接形式同样校验 target
 *
 * 输出: [{ file, type, start, end, source: 'bare' | 'link', label? }]
 */

const ALLOWED_EXT = new Set(['pptx', 'pdf', 'md', 'docx', 'xlsx'])
const SAFE_CHAR = /^[A-Za-z0-9._\-/\u4e00-\u9fa5]+$/
const MAX_LEN = 200

export function isSafeArtifactPath(raw) {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  if (!s || s.length > MAX_LEN) return false
  if (s.startsWith('/')) return false
  if (s.includes('..')) return false
  if (!SAFE_CHAR.test(s)) return false
  const dot = s.lastIndexOf('.')
  if (dot < 0) return false
  const ext = s.slice(dot + 1).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) return false
  return true
}

export function extToType(file) {
  const dot = file.lastIndexOf('.')
  return dot >= 0 ? file.slice(dot + 1).toLowerCase() : ''
}

/**
 * 解析一段 markdown, 返回 artifact 标记区间.
 *
 * 严格 regex 避免误伤 `[像这种 PPT]` 这种说明文 ——
 * 必须含 . + 已知后缀, 末尾必须立刻 ] 或 ](xxx).
 */
export function extractArtifacts(markdown) {
  if (typeof markdown !== 'string' || !markdown) return []
  const out = []

  // 1) link 形式 [label](target)
  //    target 走白名单; 防止 ] / ( / ) 出现在内部
  const linkRe = /\[([^\]\n]{1,120})\]\(([^)\s]{1,200})\)/g
  for (let m; (m = linkRe.exec(markdown)); ) {
    const label = m[1]
    const target = m[2]
    if (!isSafeArtifactPath(target)) continue
    out.push({
      source: 'link',
      file: target,
      type: extToType(target),
      label,
      start: m.index,
      end: m.index + m[0].length,
    })
  }

  // 2) 裸 marker [file.pptx]   —— 不能后跟 (, 否则归属上面的 link 形式
  const bareRe = /\[([^\]\n[]{1,200})\](?!\()/g
  for (let m; (m = bareRe.exec(markdown)); ) {
    const target = m[1]
    if (!isSafeArtifactPath(target)) continue
    out.push({
      source: 'bare',
      file: target,
      type: extToType(target),
      label: target,
      start: m.index,
      end: m.index + m[0].length,
    })
  }

  // 按位置升序, 去重 (同一区间)
  out.sort((a, b) => a.start - b.start)
  const seen = new Set()
  return out.filter((it) => {
    const key = `${it.start}-${it.end}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 把 markdown 按 artifact 区间切片, 方便外层渲染交错文本/触发器.
 * 返回 [{kind: 'text', value}, {kind: 'artifact', value: {file,type,label,...}}]
 */
export function splitByArtifacts(markdown) {
  if (typeof markdown !== 'string' || !markdown) return []
  const arts = extractArtifacts(markdown)
  if (!arts.length) return [{ kind: 'text', value: markdown }]
  const out = []
  let cursor = 0
  for (const a of arts) {
    if (a.start > cursor) {
      out.push({ kind: 'text', value: markdown.slice(cursor, a.start) })
    }
    out.push({ kind: 'artifact', value: a })
    cursor = a.end
  }
  if (cursor < markdown.length) {
    out.push({ kind: 'text', value: markdown.slice(cursor) })
  }
  return out
}
