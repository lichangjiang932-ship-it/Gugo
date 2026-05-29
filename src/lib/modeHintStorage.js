// T11: plan/code 模式提示条 dismiss 记忆的纯函数 helper
//
// 用 localStorage（或测试里注入的 mock）记一个 boolean：用户是否按过"之后不再提示"。
// 设计目标：UI 组件不直接碰 localStorage，便于 SSR/测试 mock，错误吞掉不让 UI 崩。

const KEY_PREFIX = {
  plan: 'plan_mode_hint_dismissed',
  code: 'code_mode_hint_dismissed',
}

function resolveStorage(storage) {
  if (storage) return storage
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  return null
}

function resolveKey(mode) {
  return KEY_PREFIX[mode] || null
}

export function readDismissed(mode, storage) {
  const key = resolveKey(mode)
  if (!key) return false
  const store = resolveStorage(storage)
  if (!store) return false
  try {
    const raw = store.getItem(key)
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

export function writeDismissed(mode, storage, value = true) {
  const key = resolveKey(mode)
  if (!key) return false
  const store = resolveStorage(storage)
  if (!store) return false
  try {
    if (value) {
      store.setItem(key, '1')
    } else {
      store.removeItem(key)
    }
    return true
  } catch {
    return false
  }
}

export const MODE_HINT_KEYS = { ...KEY_PREFIX }
