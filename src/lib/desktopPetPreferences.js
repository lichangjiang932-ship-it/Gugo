export const DESKTOP_PET_CUSTOM_IMAGE_KEY = 'gugo:desktop-pet:custom-image:v1'
export const DESKTOP_PET_SCALE_KEY = 'gugo:desktop-pet:scale:v1'

function storage() {
  try { return globalThis.localStorage } catch { return null }
}

export function readDesktopPetPreferences() {
  const source = storage()
  const scale = Number(source?.getItem(DESKTOP_PET_SCALE_KEY))
  return {
    customImage: source?.getItem(DESKTOP_PET_CUSTOM_IMAGE_KEY) || '',
    scale: Number.isFinite(scale) && scale >= 0.6 && scale <= 1.8 ? scale : 1,
  }
}

export function writeDesktopPetPreferences({ customImage = '', scale = 1 }) {
  const source = storage()
  if (!source) return
  source.setItem(DESKTOP_PET_CUSTOM_IMAGE_KEY, customImage)
  source.setItem(DESKTOP_PET_SCALE_KEY, String(Math.min(1.8, Math.max(0.6, Number(scale) || 1))))
  globalThis.dispatchEvent?.(new CustomEvent('gugo:desktop-pet-preferences'))
}

export function validateDesktopPetImage(file) {
  if (!file || !['image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    return 'invalidType'
  }
  if (file.size > 4 * 1024 * 1024) return 'tooLarge'
  return ''
}
