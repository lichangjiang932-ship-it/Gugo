export const PPTX_PREVIEW_BYTE_LIMITS = Object.freeze({
  xmlPart: 8 * 1024 * 1024,
  xmlTotal: 32 * 1024 * 1024,
  imagePart: 16 * 1024 * 1024,
  imageTotal: 48 * 1024 * 1024,
})

function limitError(label) {
  return new Error(`PPTX ${label} exceeds the preview limit`)
}

/** ZIP directory sizes are only an early-rejection hint. Count real inflated
 * byte chunks before retaining or concatenating them; never use entry.async()
 * for untrusted PPTX XML or media. Pausing also stops subsequent input chunks. */
export async function readPptxZipPart(entry, { limit, budget, label = 'data' }) {
  const declared = Number(entry?._data?.uncompressedSize)
  if (!entry || budget.bytes >= budget.limit || declared > limit
    || (Number.isFinite(declared) && declared > budget.limit - budget.bytes)) throw limitError(label)
  const stream = entry.internalStream('uint8array')
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let settled = false
    const fail = (cause) => {
      if (settled) return
      settled = true
      chunks.length = 0
      stream.pause()
      reject(cause)
    }
    stream.on('data', (chunk) => {
      if (settled) return
      length += chunk.byteLength
      budget.bytes += chunk.byteLength
      if (length > limit || budget.bytes > budget.limit) {
        fail(limitError(label))
        return
      }
      chunks.push(chunk)
    }).on('error', fail).on('end', () => {
      if (settled) return
      try {
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        chunks.length = 0
        settled = true
        resolve(bytes)
      } catch (cause) { fail(cause) }
    }).resume()
  })
}

export async function readPptxXmlText(entry, budget) {
  const bytes = await readPptxZipPart(entry, { limit: PPTX_PREVIEW_BYTE_LIMITS.xmlPart, budget, label: 'XML' })
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('PPTX XML entities are not supported')
  return text
}
