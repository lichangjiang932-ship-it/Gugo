export const PPTX_SHADOW_FILTER_LIMITS = Object.freeze({ pixels: 16000000, totalPixels: 32000000 })

function bounded(value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error('PPTX shadow geometry exceeds the preview limit')
  }
  return value
}

/** Canonical SVG user-space filter region, in 96-dpi pixels. */
export function pptxShadowFilterRegion(element) {
  const width = bounded(element?.w, 0, 32768)
  const height = bounded(element?.h, 0, 32768)
  const strokeWidth = bounded(element?.strokeWidth ?? 0, 0, 2048)
  const blur = bounded(element?.shadow?.blur, 0, 64)
  const dx = bounded(element?.shadow?.dx, -2048, 2048)
  const dy = bounded(element?.shadow?.dy, -2048, 2048)
  const padding = 3 * blur + Math.max(Math.abs(dx), Math.abs(dy)) + strokeWidth + 1
  const region = { x: -padding, y: -padding, width: width + 2 * padding, height: height + 2 * padding }
  if (region.width * region.height > PPTX_SHADOW_FILTER_LIMITS.pixels) {
    throw new Error('PPTX shadow area exceeds the preview limit')
  }
  return region
}
