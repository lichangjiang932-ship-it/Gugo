import { useRef } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { CHIP_CLASS } from './previewChipStyles.js'
import { ZOOM_LEVELS } from './previewZoomState.js'

export function ZoomControl({ state, t }) {
  const menuRef = useRef(null)
  const { zoom, setZoom, fitPercent } = state
  const shown = zoom === 'fit' ? (fitPercent ? `${fitPercent}%` : t('chatPreview.zoomFit')) : `${zoom}%`
  const choose = (value) => {
    setZoom(value)
    if (menuRef.current) menuRef.current.open = false
  }
  const options = [{ value: 'fit', label: t('chatPreview.zoomFit') }, ...ZOOM_LEVELS.map((level) => ({ value: level, label: `${level}%` }))]
  return (
    <details ref={menuRef} className="group relative shrink-0" onKeyDown={(event) => {
      if (event.key !== 'Escape' || !menuRef.current?.open) return
      event.preventDefault()
      event.stopPropagation()
      menuRef.current.open = false
      menuRef.current.querySelector('summary')?.focus()
    }}>
      <summary data-testid="preview-zoom" aria-label={t('chatPreview.zoom', { value: shown })} title={t('chatPreview.zoom', { value: shown })}
        className={`${CHIP_CLASS} cursor-pointer list-none tabular-nums`}>
        {shown}
        <ChevronDown className="h-3.5 w-3.5 text-ink-fade transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div role="menu" className="absolute right-0 top-full z-50 mt-1.5 w-36 rounded-xl border border-ink/10 bg-paper p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.22)]">
        {options.map((option) => (
          <button key={option.value} type="button" role="menuitemradio" aria-checked={zoom === option.value}
            data-testid={`preview-zoom-${option.value}`} onClick={() => choose(option.value)}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] tabular-nums text-ink hover:bg-ink/[0.05]">
            {option.label}
            {zoom === option.value && <Check className="h-3.5 w-3.5 text-accent-ink" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </details>
  )
}
