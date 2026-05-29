// 纯函数:把 hex 强调色 + strong 标志转成可直接喷到 :root 的 CSS 变量集合 + className.
// ThemeWrapper 用它来落 --accent-h / --accent-s / --accent-l / --accent,
// 并据 strong 决定是否给 documentElement 加 .theme-accent-strong.

function clampByte(n) {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(255, Math.round(n)))
}

function parseHex(hex) {
  if (typeof hex !== 'string') return null
  let s = hex.trim().replace(/^#/, '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  if (s.length !== 6 || /[^0-9a-fA-F]/.test(s)) return null
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  }
}

// 标准 RGB → HSL (返回 h:0..360, s:0..100, l:0..100, 整数)
export function hexToHsl(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const r = clampByte(rgb.r) / 255
  const g = clampByte(rgb.g) / 255
  const b = clampByte(rgb.b) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (delta > 0) {
    s = delta / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r:
        h = ((g - b) / delta) % 6
        break
      case g:
        h = (b - r) / delta + 2
        break
      default:
        h = (r - g) / delta + 4
    }
    h *= 60
    if (h < 0) h += 360
  }
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  }
}

const DEFAULT_HEX = '#E86A3C' // ember

/**
 * applyAccent({ hex, strong }) → { vars, className }
 *   vars: 形如 { '--accent-h': '21', '--accent-s': '79%', '--accent-l': '57%', '--accent': 'hsl(...)' }
 *   className: 'theme-accent-strong' | ''
 * 调用方负责把 vars 喷到 documentElement.style,把 className toggle 到 classList.
 */
export function applyAccent({ hex, strong } = {}) {
  const hsl = hexToHsl(hex) || hexToHsl(DEFAULT_HEX)
  // strong 模式把亮度压一档、饱和度顶一档,让色块更"扎眼".
  const finalS = strong ? Math.min(100, hsl.s + 8) : hsl.s
  const finalL = strong ? Math.max(0, hsl.l - 6) : hsl.l
  const vars = {
    '--accent-h': String(hsl.h),
    '--accent-s': `${finalS}%`,
    '--accent-l': `${finalL}%`,
    '--accent': `hsl(${hsl.h} ${finalS}% ${finalL}%)`,
  }
  return {
    vars,
    className: strong ? 'theme-accent-strong' : '',
  }
}

export const ACCENT_DEFAULT_HEX = DEFAULT_HEX
