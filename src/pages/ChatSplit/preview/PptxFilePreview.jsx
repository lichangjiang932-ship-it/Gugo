import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, FileWarning, Maximize2, RefreshCw } from 'lucide-react'
import Modal from '../../../components/Modal.jsx'
import { OpenOriginalLink } from './PreviewPrimitives.jsx'
import PptxSlideCanvas from './PptxSlideCanvas.jsx'
import { useElementSize, usePreviewZoom } from './previewZoomState.js'

// The pane's own horizontal padding, taken off the width a slide is fitted into.
const PANE_PADDING_PX = 32

/**
 * One slide, full screen, walked with the arrows on either side or the left and
 * right keys — the shape a deck is judged in when the pane is too narrow to read
 * a layout at a glance.
 */
function PptxFullscreenViewer({ slides, index, stepIndex, onClose, t }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      stepIndex(event.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepIndex])

  const slide = slides[index]
  if (!slide?.layout) return null
  const width = Number(slide.layout.width) || 1280
  const height = Number(slide.layout.height) || 720
  const arrowClass = 'absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:opacity-30'
  const multiple = slides.length > 1
  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('chatPreview.pptxFullscreen')}
      overlayClassName="bg-black/95 p-0 select-none"
      className="h-full max-w-none overflow-hidden rounded-none border-0 bg-transparent shadow-none"
    >
      <div
        className="absolute inset-0 flex items-center justify-center"
        onClick={(event) => { if (event.target === event.currentTarget) onClose?.() }}
      >
        <button type="button" onClick={() => stepIndex(-1)} disabled={!multiple} className={`${arrowClass} left-4`} aria-label={t('chatPreview.previousPage')}>
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        {/* The width is the narrower of the viewport share and the width that
            makes the slide exactly as tall as the viewport allows, so a wide
            deck and a tall one both land inside the screen uncropped. */}
        <div style={{ width: `min(92vw, calc(88vh * ${width / height}))`, aspectRatio: `${width} / ${height}` }}>
          <PptxSlideCanvas slide={slide} testId="pptx-original-layout-fullscreen" />
        </div>
        <button type="button" onClick={() => stepIndex(1)} disabled={!multiple} className={`${arrowClass} right-4`} aria-label={t('chatPreview.nextPage')}>
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
        {multiple && (
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-white/10 px-3 py-1.5 font-mono text-xs tabular-nums text-white">
            {index + 1} / {slides.length}
          </span>
        )}
      </div>
    </Modal>
  )
}

/**
 * A binary PPTX deck, read the way a deck is read: the pages run down the pane
 * and the wheel walks them, so a change on page four is visible without paging
 * to it. Pressing a page opens that page full screen.
 *
 * Binary PPTX previews never pass through the Markdown deck template.
 */
export default function PptxFilePreview({ preview, url, t, onReload }) {
  const slides = preview.slides || []
  const [fullscreenIndex, setFullscreenIndex] = useState(null)
  const [frameRef, frame] = useElementSize()
  const { zoom, setFitPercent } = usePreviewZoom()
  const firstWidth = Number(slides.find((slide) => slide?.layout)?.layout?.width) || 0
  // "Fit" in a stacked deck means fit the pane's width: the height then follows,
  // and the reader scrolls. A chosen level is that share of the slide's own size.
  const fitScale = firstWidth > 0 && frame.width > 0
    ? Math.max(0.05, (frame.width - PANE_PADDING_PX) / firstWidth)
    : 1
  useEffect(() => {
    if (zoom === 'fit' && firstWidth > 0 && frame.width > 0) setFitPercent(Math.round(fitScale * 100))
  }, [fitScale, frame.width, firstWidth, setFitPercent, zoom])

  // The step is resolved against the current index rather than the one this
  // render saw, so a held-down arrow key cannot land twice on the same page.
  const stepFullscreen = useCallback(
    (delta) => setFullscreenIndex((current) => (current + delta + slides.length) % slides.length),
    [slides.length],
  )

  if (!slides.length) return null
  const scaleFor = (slide) => {
    if (zoom !== 'fit') return Number(zoom) / 100
    const width = Number(slide?.layout?.width) || 0
    return width > 0 && frame.width > 0 ? Math.max(0.05, (frame.width - PANE_PADDING_PX) / width) : 1
  }
  const buttonClass = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-full px-1.5 text-xs text-ink-soft hover:bg-ink/[0.06]'
  return <div className="relative flex h-full min-h-0 flex-col bg-paper-2" data-testid="pptx-file-preview">
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-ink/10 bg-paper px-3">
      <span className="text-xs tabular-nums text-ink-soft">{t('chatPreview.pptxSlideCount', { count: slides.length })}</span>
      {onReload && <button type="button" className={buttonClass} onClick={onReload} aria-label={t('chatPreview.refreshPreview')} title={t('chatPreview.refreshPreview')}><RefreshCw className="h-3.5 w-3.5" /></button>}
    </div>
    <div ref={frameRef} className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-full flex-col items-center gap-4">
        {slides.map((slide, index) => slide.layout ? (
          <button
            key={index}
            type="button"
            data-slide-index={index}
            onClick={() => setFullscreenIndex(index)}
            title={t('chatPreview.pptxEnlargeSlide')}
            aria-label={t('chatPreview.pptxEnlargeSlide')}
            className="group relative block max-w-full cursor-zoom-in rounded-[2px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-focus/40"
            style={{ width: `${Math.round((Number(slide.layout.width) || 0) * scaleFor(slide))}px` }}
          >
            {/* Each page carries its own id: a stacked deck puts one canvas per
                page in the pane, and a single testid for all of them would name
                whichever came first. */}
            <PptxSlideCanvas slide={slide} testId={`pptx-original-layout-${index}`} />
            <span className="pointer-events-none absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-ink/55 text-paper opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </button>
        ) : (
          <section key={index} role="status" className="flex min-h-52 w-full flex-col items-center justify-center gap-3 rounded-card border border-ink/10 bg-paper p-6 text-center" data-testid="pptx-layout-unavailable">
            <FileWarning className="h-7 w-7 text-ink-fade" aria-hidden="true" />
            <h3 className="text-sm font-medium text-ink">{t('chatPreview.pptxUnavailableTitle')}</h3>
            <p className="max-w-md text-xs leading-relaxed text-ink-soft">{t('chatPreview.pptxOutlineNotice')}</p>
            <OpenOriginalLink t={t} url={url} />
          </section>
        ))}
      </div>
    </div>
    {fullscreenIndex !== null && (
      <PptxFullscreenViewer
        slides={slides}
        index={fullscreenIndex}
        stepIndex={stepFullscreen}
        onClose={() => setFullscreenIndex(null)}
        t={t}
      />
    )}
  </div>
}
