import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileText, LoaderCircle } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import { classifyDirectFile, loadDirectFilePreview } from '../../../lib/directFilePreview.js'
import { DocxPreview, HtmlPreview, PptxPreview, SourceView, XlsxPreview } from './ArtifactRenderers.jsx'

export default function DirectFilePreview({ file, url, t }) {
  const filename = String(file?.filename || '')
  const title = String(file?.title || '')
  const type = String(file?.type || '')
  const mimeType = String(file?.mimeType || '')
  const previewFile = useMemo(() => ({ filename, title, type, mimeType }), [filename, mimeType, title, type])
  const kind = classifyDirectFile(previewFile)
  const needsFetch = !['pdf', 'image', 'audio', 'video', 'unsupported'].includes(kind)
  const requestKey = `${kind}:${url}:${filename}:${mimeType}`
  const [loadState, setLoadState] = useState(() => ({ key: '', preview: null, error: '' }))

  useEffect(() => {
    if (!needsFetch) return undefined
    const controller = new AbortController()
    loadDirectFilePreview({
      file: previewFile,
      url,
      fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    }).then((result) => {
      if (!controller.signal.aborted) setLoadState({ key: requestKey, preview: result, error: '' })
    }).catch((cause) => {
      if (!controller.signal.aborted) setLoadState({ key: requestKey, preview: null, error: cause?.message || String(cause) })
    })
    return () => controller.abort()
  }, [needsFetch, previewFile, requestKey, url])

  const currentLoadState = loadState.key === requestKey ? loadState : null
  const preview = needsFetch ? currentLoadState?.preview : { kind, url }
  const loading = needsFetch && !currentLoadState
  const error = currentLoadState?.error || ''

  if (loading) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  if (error) return <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')} detail={error} />
  if (['image', 'pdf', 'audio', 'video'].includes(preview.kind)) return <NativeFilePreview key={`${preview.kind}:${url}`} kind={preview.kind} file={file} url={url} t={t} />
  if (preview.kind === 'html') return <HtmlPreview html={preview.html} />
  if (preview.kind === 'docx') return <DocxPreview blocks={preview.blocks || []} title={preview.title} />
  if (preview.kind === 'pptx') return <PptxPreview content={preview.content || ''} />
  if (preview.kind === 'xlsx') return <WorkbookPreview sheets={preview.sheets || []} />
  if (preview.kind === 'csv') return <XlsxPreview rows={preview.rows || []} />
  if (preview.kind === 'markdown') return <div className="h-full overflow-auto bg-paper px-6 py-5"><MarkdownRenderer>{preview.text}</MarkdownRenderer></div>
  if (['json', 'xml', 'code', 'text'].includes(preview.kind)) return <SourceView content={preview.text || ''} />
  return <PreviewStatus icon={<FileText className="h-6 w-6" />} text={file.filename || file.title || 'artifact'} detail={t('chatPreview.unsupportedHint')} />
}

function NativeFilePreview({ file, kind, t, url }) {
  const [status, setStatus] = useState('loading')
  const ready = () => setStatus('ready')
  const failed = () => setStatus('failed')
  return (
    <div className={`relative flex h-full min-h-0 items-center justify-center overflow-auto ${kind === 'video' ? 'bg-black p-3' : 'bg-paper-2 p-5'}`}>
      {kind === 'image' && <img src={url} alt={file.filename || file.title || ''} onLoad={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} max-h-full max-w-full rounded-sm object-contain shadow-sm`} />}
      {kind === 'pdf' && <iframe src={url} title={file.filename || file.title || 'PDF'} onLoad={ready} onError={failed} referrerPolicy="no-referrer" className={`${status === 'failed' ? 'hidden' : 'block'} h-full w-full border-0 bg-white`} />}
      {kind === 'audio' && <audio controls preload="metadata" src={url} onLoadedMetadata={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} w-full max-w-xl`} />}
      {kind === 'video' && <video controls preload="metadata" src={url} onLoadedMetadata={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} max-h-full max-w-full`} />}
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {status === 'failed' && <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')} detail={t('chatPreview.unsupportedHint')} />}
    </div>
  )
}

function WorkbookPreview({ sheets }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const safeActiveIndex = Math.min(activeIndex, Math.max(0, sheets.length - 1))
  const active = sheets[safeActiveIndex] || sheets[0] || { rows: [] }
  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink/10 bg-paper-2 px-2 py-1.5">
          {sheets.map((sheet, index) => <button key={`${index}-${sheet.name}`} type="button" onClick={() => setActiveIndex(index)} className={`h-7 shrink-0 rounded-md px-2.5 text-[11px] ${index === safeActiveIndex ? 'bg-paper font-medium text-ink shadow-sm' : 'text-ink-fade hover:text-ink'}`}>{sheet.name}</button>)}
        </div>
      )}
      <div className="min-h-0 flex-1"><XlsxPreview rows={active.rows || []} /></div>
    </div>
  )
}

function PreviewStatus({ icon, text, detail = '' }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center text-ink-fade" role="status">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ink/10 bg-paper shadow-sm">{icon}</span>
      <p className="max-w-sm text-sm font-medium text-ink-soft">{text}</p>
      {detail && <p className="max-w-sm break-words text-xs leading-relaxed text-ink-fade">{detail}</p>}
    </div>
  )
}
