export const DESKTOP_PET_MIN_SCALE = 0.6
export const DESKTOP_PET_MAX_SCALE = 1.8

const SPRITE_FRAME = Object.freeze({ width: 73, height: 79 })
const CUSTOM_IMAGE_FRAME = Object.freeze({ width: 96, height: 96 })

function normalizeScale(value) {
  const scale = Number(value)
  if (!Number.isFinite(scale)) return 1
  return Math.min(DESKTOP_PET_MAX_SCALE, Math.max(DESKTOP_PET_MIN_SCALE, scale))
}

export function resolveDesktopPetLayout({ customImage = false, scale = 1 } = {}) {
  const normalizedScale = normalizeScale(scale)
  const frame = customImage ? CUSTOM_IMAGE_FRAME : SPRITE_FRAME
  const contentWidth = Math.max(1, Math.round(frame.width * normalizedScale))
  const contentHeight = Math.max(1, Math.round(frame.height * normalizedScale))
  return {
    contentWidth,
    contentHeight,
    windowWidth: contentWidth,
    windowHeight: contentHeight,
    scale: normalizedScale,
  }
}

export const DEFAULT_DESKTOP_PET_LAYOUT = Object.freeze(resolveDesktopPetLayout())
