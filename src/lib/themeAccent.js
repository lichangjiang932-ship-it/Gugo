// 纯函数:把 hex 强调色转成可直接喷到 :root 的 CSS 变量集合.
// ThemeWrapper 用它来落 --accent-h / --accent-s / --accent-l / --accent,
// 颜色强度保持一致,不再提供额外的强色调模式.

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

const DEFAULT_HEX = '#16A34A' // brand green (accent picker removed, fixed brand accent)
const LIGHT_CONTRAST_RGB = { r: 255, g: 255, b: 255 }
const DARK_CONTRAST_RGB = { r: 0, g: 0, b: 0 }

function relativeLuminance({ r, g, b }) {
  const channels = [r, g, b].map((value) => {
    const channel = clampByte(value) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05)
}

export function accentContrastRgb(hex) {
  const accent = parseHex(hex) || parseHex(DEFAULT_HEX)
  const foreground = contrastRatio(accent, DARK_CONTRAST_RGB) >= contrastRatio(accent, LIGHT_CONTRAST_RGB)
    ? DARK_CONTRAST_RGB
    : LIGHT_CONTRAST_RGB
  return `${foreground.r} ${foreground.g} ${foreground.b}`
}

/**
 * applyAccent({ hex }) → { vars }
 *   vars: 形如 { '--accent-h': '21', '--accent-s': '79%', '--accent-l': '57%', '--accent': 'hsl(...)' }
 * 调用方负责把 vars 喷到 documentElement.style.
 */
export function applyAccent({ hex } = {}) {
  const hsl = hexToHsl(hex) || hexToHsl(DEFAULT_HEX)
  const finalS = hsl.s
  const finalL = hsl.l
  const vars = {
    '--workbench-accent-h': String(hsl.h),
    '--workbench-accent-s': `${finalS}%`,
    '--workbench-accent-l': `${finalL}%`,
    '--workbench-accent': `hsl(${hsl.h} ${finalS}% ${finalL}%)`,
    '--accent-h': String(hsl.h),
    '--accent-s': `${finalS}%`,
    '--accent-l': `${finalL}%`,
    '--accent': `hsl(${hsl.h} ${finalS}% ${finalL}%)`,
    '--color-accent-contrast-rgb': accentContrastRgb(hex),
  }
  return { vars }
}

export const ACCENT_DEFAULT_HEX = DEFAULT_HEX
