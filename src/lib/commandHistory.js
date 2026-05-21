/**
 * Feature 9: localStorage 最近 50 条命令的环形缓冲。
 *
 * 调用者:
 *   - ChatComposer 在 / 触发时把最近命令置顶
 *   - CommandPalette 默认按最近使用排序
 */

const KEY = 'your-model-atelier:command-history:v1'
const MAX = 50

function read() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function write(arr) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(arr.slice(0, MAX)))
  } catch {
    /* localStorage 满了不影响功能 */
  }
}

export function recordCommandUse(commandId, args = {}) {
  if (!commandId) return
  const arr = read()
  // 同 id 的旧记录前置
  const filtered = arr.filter((e) => e.id !== commandId)
  filtered.unshift({ id: commandId, args, t: Date.now() })
  write(filtered)
}

export function getRecentCommands(limit = 10) {
  return read().slice(0, limit)
}

export function clearCommandHistory() {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(KEY) } catch { /* ignore */ }
}
