import { createContext, useContext, useEffect, useState } from 'react'
import { loadRemoteMarkdownImage, remoteMarkdownImageUrl } from '../../lib/remoteMarkdownImage.js'

const ImageContext = createContext({ loadRemote: true, onOpen: null })

export function MarkdownImageProvider({ children, loadRemote, onOpen }) {
  return <ImageContext.Provider value={{ loadRemote, onOpen }}>{children}</ImageContext.Provider>
}

// Keep the component type stable across MarkdownRenderer updates: opening the
// fullscreen modal must not unmount the owner and revoke its displayed blob.
export function MarkdownImageRenderer({ src, alt = '' }) {
  const options = useContext(ImageContext)
  return <MarkdownImage
    src={src}
    alt={alt}
    loadRemote={options.loadRemote}
    onOpen={(imageSrc) => options.onOpen?.({ src: imageSrc, alt })}
  />
}

export default function MarkdownImage({ src, alt = '', onOpen, loadRemote = true }) {
  const remoteUrl = remoteMarkdownImageUrl(src)
  const [loaded, setLoaded] = useState(null)
  useEffect(() => {
    if (!remoteUrl || !loadRemote) return undefined
    const controller = new AbortController()
    let active = true
    let objectUrl = null
    loadRemoteMarkdownImage(remoteUrl, { signal: controller.signal }).then((blob) => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      setLoaded({ url: remoteUrl, src: objectUrl })
    }).catch((error) => {
      if (active) setLoaded({ url: remoteUrl, error: error?.code || 'REMOTE_IMAGE_FAILED' })
    })
    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [loadRemote, remoteUrl])
  const current = loaded?.url === remoteUrl ? loaded : null
  const resolvedSrc = remoteUrl ? current?.src : src
  if (!resolvedSrc) return (
    <span
      data-testid="remote-markdown-image-placeholder"
      data-error-code={current?.error}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-busy={Boolean(remoteUrl && !current)}
      className="inline-block rounded-control border border-ink-fade/30 px-2 py-1 text-ink-fade"
    >{alt || '◻'}</span>
  )
  return <img
    src={resolvedSrc}
    alt={alt}
    className="h-auto max-w-full cursor-zoom-in rounded-control border border-ink-fade/30"
    onClick={() => onOpen?.(resolvedSrc)}
  />
}
