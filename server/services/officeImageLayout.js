function finitePositive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export function officeImageSize(image, { defaultWidth = 4, maxWidth = 10, maxHeight = 6 } = {}) {
  const ratio = finitePositive(image?.pixelWidth, 1) / finitePositive(image?.pixelHeight, 1)
  let width = finitePositive(image?.width, defaultWidth)
  let height = finitePositive(image?.height, width / ratio)
  if (width > maxWidth) {
    height *= maxWidth / width
    width = maxWidth
  }
  if (height > maxHeight) {
    width *= maxHeight / height
    height = maxHeight
  }
  return { width, height }
}
