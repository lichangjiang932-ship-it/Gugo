import { useState } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import { XlsxPreview } from './ArtifactRenderers.jsx'
import { PreviewFallbackActions, PreviewStatus } from './PreviewPrimitives.jsx'
import { withPreviewRetry } from './previewUrl.js'

export function NativePreviewRenderer({ file, preview, t, url }) {
  return <NativeFilePreview key={`${preview.kind}:${url}`} kind={preview.kind} file={file} url={url} t={t} />
}

function NativeFilePreview({ file, kind, t, url }) {
  const [status, setStatus] = useState('loading')
  const [attempt, setAttempt] = useState(0)
  const requestUrl = withPreviewRetry(url, attempt)
  const ready = () => setStatus('ready')
  const failed = () => setStatus('failed')
  const retry = () => {
    setStatus('loading')
    setAttempt((value) => value + 1)
  }
  return (
    <div className={`relative flex h-full min-h-0 items-center justify-center overflow-auto ${kind === 'video' ? 'bg-black p-3' : 'bg-paper-2 p-5'}`}>
      {kind === 'image' && <img key={attempt} src={requestUrl} alt={file.filename || file.title || ''} onLoad={ready} onError={failed} referrerPolicy="no-referrer" className={`${status === 'failed' ? 'hidden' : 'block'} max-h-full max-w-full rounded-control object-contain shadow-sm`} />}
      {kind === 'pdf' && <iframe key={attempt} src={requestUrl} title={file.filename || file.title || 'PDF'} onLoad={ready} onError={failed} referrerPolicy="no-referrer" className={`${status === 'failed' ? 'hidden' : 'block'} h-full w-full border-0 bg-white`} />}
      {kind === 'audio' && <audio key={attempt} controls preload="metadata" src={requestUrl} onLoadedMetadata={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} w-full max-w-xl`} />}
      {kind === 'video' && <video key={attempt} controls preload="metadata" src={requestUrl} onLoadedMetadata={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} max-h-full max-w-full`} />}
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {status === 'failed' && <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')} detail={t('chatPreview.unsupportedHint')} action={<PreviewFallbackActions onRetry={retry} t={t} url={url} />} />}
    </div>
  )
}

export function WorkbookPreview({ sheets }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const safeActiveIndex = Math.min(activeIndex, Math.max(0, sheets.length - 1))
  const active = sheets[safeActiveIndex] || sheets[0] || { rows: [] }
  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink/10 bg-paper-2 px-2 py-1.5">
          {sheets.map((sheet, index) => <button key={`${index}-${sheet.name}`} type="button" onClick={() => setActiveIndex(index)} className={`h-7 shrink-0 rounded-control px-2.5 text-xs ${index === safeActiveIndex ? 'bg-paper font-medium text-ink shadow-sm' : 'text-ink-fade hover:text-ink'}`}>{sheet.name}</button>)}
        </div>
      )}
      <div className="min-h-0 flex-1"><XlsxPreview rows={active.rows || []} /></div>
    </div>
  )
}
