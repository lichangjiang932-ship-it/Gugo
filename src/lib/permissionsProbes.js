// 浏览器权限/能力探针 —— 纯函数，便于在 node:test 里 mock globals。
//
// 状态枚举：'granted' | 'denied' | 'prompt' | 'unsupported' | 'unknown'
//
// 设计原则：
//   - 探针只读不写、不主动弹权限请求（除非通过 dashboard 的「请求」按钮显式触发）。
//   - 所有 API 都用可选 dep-injection（{ storage, win, navigator }）方便单测。
//   - 任何意外抛错都吞掉、统一回到 'unknown'，不让权限页崩。

const PROBE_KEY = '__probe__'

export function probeLocalStorage({ storage } = {}) {
  const ls = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
  if (!ls) return { state: 'unsupported' }
  try {
    ls.setItem(PROBE_KEY, '1')
    ls.removeItem(PROBE_KEY)
    return { state: 'granted' }
  } catch {
    // Safari 隐私模式 / 配额耗尽 / SecurityError 等 → denied
    return { state: 'denied' }
  }
}

export async function probeStorage({ navigator: nav } = {}) {
  const n = nav ?? (typeof navigator !== 'undefined' ? navigator : null)
  if (!n || !n.storage || typeof n.storage.estimate !== 'function') {
    return { state: 'unsupported' }
  }
  try {
    const est = await n.storage.estimate()
    const usage = Number.isFinite(est?.usage) ? est.usage : 0
    const quota = Number.isFinite(est?.quota) ? est.quota : 0
    const detail = `${(usage / 1024 / 1024).toFixed(1)}MB / ${(quota / 1024 / 1024).toFixed(0)}MB`
    if (quota > 0 && usage < quota) {
      return { state: 'granted', detail }
    }
    return { state: 'denied', detail }
  } catch {
    return { state: 'unknown' }
  }
}

export function probeNotifications({ win } = {}) {
  const w = win ?? (typeof window !== 'undefined' ? window : null)
  if (!w || !('Notification' in w) || !w.Notification) {
    return { state: 'unsupported' }
  }
  const perm = w.Notification.permission
  if (perm === 'granted') return { state: 'granted' }
  if (perm === 'denied') return { state: 'denied' }
  // 'default' 或其他未知值 → 待请求
  return { state: 'prompt' }
}

// 通用媒体探针：name = 'microphone' | 'camera'
// 优先用 navigator.permissions.query；fallback 仅做能力探测（不主动调 getUserMedia 弹框）。
export async function probeMedia(name, { navigator: nav } = {}) {
  if (name !== 'microphone' && name !== 'camera') {
    return { state: 'unknown' }
  }
  const n = nav ?? (typeof navigator !== 'undefined' ? navigator : null)
  if (!n) return { state: 'unsupported' }

  // Permissions API（Chrome / Edge / 部分 Firefox 支持）
  if (n.permissions && typeof n.permissions.query === 'function') {
    try {
      const res = await n.permissions.query({ name })
      const s = res?.state
      if (s === 'granted' || s === 'denied' || s === 'prompt') {
        return { state: s }
      }
    } catch {
      // 某些浏览器（Safari/Firefox）对 mic/camera name 抛 TypeError → 走 fallback
    }
  }

  // Fallback：仅检测能力，**不**调用 getUserMedia（那会弹权限框）
  if (n.mediaDevices && typeof n.mediaDevices.getUserMedia === 'function') {
    return { state: 'prompt' }
  }
  return { state: 'unsupported' }
}
