import { useState } from 'react'
import { ChevronLeft, ChevronRight, FileWarning, RefreshCw } from 'lucide-react'
import { OpenOriginalLink } from './PreviewPrimitives.jsx'
import PptxSlideCanvas from './PptxSlideCanvas.jsx'

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
  if (!slide) return null
  const buttonClass = 'inline-flex h-8 items-center justify-center gap-1 rounded-control border border-ink/10 bg-paper px-2 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-40'
  return <div className="flex h-full min-h-0 flex-col bg-paper-2" data-testid="pptx-file-preview">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink/10 bg-paper p-3">
      <button type="button" className={buttonClass} disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)} aria-label={t('chatPreview.previousPage')}><ChevronLeft className="h-4 w-4" /></button>
      <span className="text-xs tabular-nums text-ink-soft" aria-live="polite">{pageIndex + 1} / {slides.length}</span>
      <button type="button" className={buttonClass} disabled={pageIndex >= slides.length - 1} onClick={() => setPage(pageIndex + 1)} aria-label={t('chatPreview.nextPage')}><ChevronRight className="h-4 w-4" /></button>
      {onReload && <button type="button" className={buttonClass} onClick={onReload}><RefreshCw className="h-3.5 w-3.5" />{t('chatPreview.refreshPreview')}</button>}
      <OpenOriginalLink t={t} url={url} />
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {slide.layout ? <>
        <PptxSlideCanvas slide={slide} />
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
