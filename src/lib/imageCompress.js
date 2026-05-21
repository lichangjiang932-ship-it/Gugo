/**
 * Feature 5: 图片压缩
 *
 * 浏览器 canvas 缩到最大 maxDim=1568（Anthropic vision 推荐值），
 * 输出 image/jpeg @ quality 0.85，再编成 dataURL。
 *
 * 失败时返回原 dataURL（不阻塞主流程）。
 */

const DEFAULT_MAX_DIM = 1568
const DEFAULT_QUALITY = 0.85

export async function compressImageDataUrl(dataUrl, { maxDim = DEFAULT_MAX_DIM, quality = DEFAULT_QUALITY } = {}) {
  if (typeof window === 'undefined' || !dataUrl?.startsWith('data:image/')) return dataUrl
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const { width, height } = img
        const ratio = Math.min(1, maxDim / Math.max(width, height))
        if (ratio >= 1) { resolve(dataUrl); return }
        const w = Math.round(width * ratio)
        const h = Math.round(height * ratio)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        // PNG 保持透明,其它统一 JPEG
        const isPng = /^data:image\/png/i.test(dataUrl)
        const out = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality)
        resolve(out)
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}
