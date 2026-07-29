/**
 * 把一条 assistant 消息拆成「按真实发生顺序」的片段序列。
 *
 * 背景:消息里 content 是一整个字符串,toolCalls 是另一个数组,两者结构上
 * 分离,渲染时只能整块堆在一起 —— 用户看到的是「一大坨工具调用 + 最后的
 * 回复」,读起来像「先给结论后干活」,顺序是反的。
 *
 * 每个 toolCall 落库时记了 textOffset(那一刻正文已经写到哪),用它就能
 * 还原真实时间线:说一段 → 干几件事 → 再说一段 → 再干几件事。
 *
 * 老数据没有 textOffset,一律当 0 处理(退化成旧的「工具在前」布局),
 * 不会崩,也不会把历史消息渲染乱。
 */

/**
 * @param {string} content 消息正文
 * @param {Array} toolCalls 工具调用列表(可能带 textOffset)
 * @returns {Array<{kind:'text',text:string} | {kind:'tools',calls:Array}>}
 */
export function buildMessageTimeline(content = '', toolCalls = []) {
  const text = typeof content === 'string' ? content : ''
  const calls = Array.isArray(toolCalls) ? toolCalls.filter(Boolean) : []

  if (!calls.length) {
    return text ? [{ kind: 'text', text }] : []
  }

  // 按 textOffset 分组:同一个 offset 上的调用是「同一批」,一起渲染。
  // 缺 textOffset 的老数据归到 0,自然排在最前面。
  const groups = new Map()
  for (const call of calls) {
    const raw = Number(call.textOffset)
    // 负数 / NaN / 超过正文长度都夹到合法区间,避免切出乱序或空片段
    const offset = Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), text.length)) : 0
    if (!groups.has(offset)) groups.set(offset, [])
    groups.get(offset).push(call)
  }

  const offsets = [...groups.keys()].sort((a, b) => a - b)
  const segments = []
  let cursor = 0

  for (const offset of offsets) {
    if (offset > cursor) {
      const chunk = text.slice(cursor, offset)
      if (chunk) segments.push({ kind: 'text', text: chunk })
      cursor = offset
    }
    segments.push({ kind: 'tools', calls: groups.get(offset) })
  }

  // 最后一批工具之后模型还说的话
  if (cursor < text.length) {
    const tail = text.slice(cursor)
    if (tail) segments.push({ kind: 'text', text: tail })
  }

  return segments
}
