import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, FileWarning, RefreshCw } from 'lucide-react'
import { OpenOriginalLink } from './PreviewPrimitives.jsx'
import PptxSlideCanvas from './PptxSlideCanvas.jsx'
import { previewScale, useElementWidth, usePreviewZoom } from './previewZoomState.js'

function SlideOutline({ slide, t }) {
  return <section className="space-y-3 rounded-card border border-ink/10 bg-paper p-5" data-testid="pptx-text-outline">
    <h3 className="break-words text-base font-semibold text-ink">{slide.title}</h3>
    {slide.lines.length ? slide.lines.map((line, index) => <p className="whitespace-pre-wrap break-words text-sm text-ink-soft" key={index}>{line}</p>)
      : <p className="text-sm text-ink-fade">{t('chatPreview.pptxNoText')}</p>}
  </section>
}

// Binary PPTX previews never pass through the Markdown deck template. A text
// outline is separate from the canvas, including when a page cannot render.
export default function PptxFilePreview({ preview, url, t, onReload }) {
  const [page, setPage] = useState(0)
  const slides = preview.slides || []
  const pageIndex = Math.min(page, Math.max(0, slides.length - 1))
  const slide = slides[pageIndex]
  const [frameRef, frameWidth] = useElementWidth()
  const { zoom, setFitPercent } = usePreviewZoom()
  // The slide keeps its own aspect; fit draws it at the pane's width, a chosen
  // zoom at that share of the slide's own size.
  const slideWidth = Number(slide?.layout?.width) || 0
  const scale = previewScale(zoom, slideWidth, frameWidth)
  useEffect(() => {
    if (zoom === 'fit' && slideWidth > 0 && frameWidth > 0) setFitPercent(Math.round(scale * 100))
  }, [frameWidth, scale, setFitPercent, slideWidth, zoom])
  if (!slide) return null
  const buttonClass = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-full px-1.5 text-xs text-ink-soft hover:bg-ink/[0.06] disabled:opacity-35'
  return <div className="relative flex h-full min-h-0 flex-col bg-paper-2" data-testid="pptx-file-preview">
    <div className="flex h-10 shrink-0 items-center justify-center gap-1 border-b border-ink/10 bg-paper px-3">
      <button type="button" className={buttonClass} disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)} aria-label={t('chatPreview.previousPage')}><ChevronLeft className="h-4 w-4" /></button>
      <span className="min-w-12 text-center text-xs tabular-nums text-ink-soft" aria-live="polite">{pageIndex + 1} / {slides.length}</span>
      <button type="button" className={buttonClass} disabled={pageIndex >= slides.length - 1} onClick={() => setPage(pageIndex + 1)} aria-label={t('chatPreview.nextPage')}><ChevronRight className="h-4 w-4" /></button>
      {onReload && <button type="button" className={`${buttonClass} absolute right-3`} onClick={onReload} aria-label={t('chatPreview.refreshPreview')} title={t('chatPreview.refreshPreview')}><RefreshCw className="h-3.5 w-3.5" /></button>}
    </div>
    <div ref={frameRef} className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {slide.layout ? <>
        <div className="mx-auto" style={{ width: zoom === 'fit' ? '100%' : `${Math.round(slideWidth * scale)}px`, maxWidth: zoom === 'fit' ? `${slideWidth}px` : 'none' }}>
          <PptxSlideCanvas slide={slide} />
        </div>
        <p role="status" className="text-xs leading-relaxed text-ink-fade">{t('chatPreview.pptxLayoutNotice')}</p>
      </> : <section role="status" className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-card border border-ink/10 bg-paper p-6 text-center" data-testid="pptx-layout-unavailable">
        <FileWarning className="h-7 w-7 text-ink-fade" aria-hidden="true" />
        <h3 className="text-sm font-medium text-ink">{t('chatPreview.pptxUnavailableTitle')}</h3>
        <p className="max-w-md text-xs leading-relaxed text-ink-soft">{t('chatPreview.pptxOutlineNotice')}</p>
        <OpenOriginalLink t={t} url={url} />
      </section>}
      <details className="rounded-control border border-ink/10 bg-paper p-3">
        <summary className="cursor-pointer text-xs text-ink-soft">{t('chatPreview.pptxTextOutline')}</summary>
        <div className="pt-3"><SlideOutline slide={slide} t={t} /></div>
      </details>
    </div>
  </div>
}
