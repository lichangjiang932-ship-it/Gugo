import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileText, LoaderCircle, RefreshCw } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import { classifyDirectFile, loadDirectFilePreview } from '../../../lib/directFilePreview.js'
import { createLocalHtmlPreviewSession, loadArtifactPreviewDocument, revokeLocalHtmlPreviewSession } from '../../../lib/jobClient.js'
import { applyHtmlArtifactDocumentPolicy } from '../../../../shared/htmlArtifactPolicy.js'
import { DocxPreview, PptxPreview, SourceView, XlsxPreview } from './ArtifactRenderers.jsx'

export default function DirectFilePreview({ file, url, t }) {
  const filename = String(file?.filename || '')
  const title = String(file?.title || '')
  const type = String(file?.type || '')
  const mimeType = String(file?.mimeType || '')
  const previewFile = useMemo(() => ({ filename, title, type, mimeType }), [filename, mimeType, title, type])
  const kind = classifyDirectFile(previewFile)
  const needsFetch = !['pdf', 'image', 'audio', 'video', 'html', 'unsupported'].includes(kind)
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
  if (preview.kind === 'html') return <InteractiveHtmlFilePreview key={`html:${url}`} file={file} url={url} t={t} />
  if (preview.kind === 'docx') return <DocxPreview blocks={preview.blocks || []} title={preview.title} />
  if (preview.kind === 'pptx') return <PptxPreview content={preview.content || ''} />
  if (preview.kind === 'xlsx') return <WorkbookPreview sheets={preview.sheets || []} />
  if (preview.kind === 'csv') return <XlsxPreview rows={preview.rows || []} />
  if (preview.kind === 'markdown') return <div className="h-full overflow-auto bg-paper px-6 py-5"><MarkdownRenderer>{preview.text}</MarkdownRenderer></div>
  if (['json', 'xml', 'code', 'text'].includes(preview.kind)) return <SourceView content={preview.text || ''} />
  return <PreviewStatus icon={<FileText className="h-6 w-6" />} text={file.filename || file.title || 'artifact'} detail={t('chatPreview.unsupportedHint')} />
}

function isManagedArtifactPreviewUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(raw, baseOrigin)
    return parsed.origin === baseOrigin && parsed.pathname.startsWith('/api/artifacts/')
  } catch {
    return false
  }
}

function InteractiveHtmlFilePreview({ file, t, url }) {
  if (isManagedArtifactPreviewUrl(url)) {
    return <ManagedHtmlArtifactPreview file={file} t={t} url={url} />
  }
  if (isVerifiedLocalFileUrl(url)) {
    return <VerifiedLocalHtmlPreview file={file} t={t} url={url} />
  }
  return <DirectHtmlUrlPreview file={file} t={t} url={url} />
}

function isVerifiedLocalFileUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(raw, baseOrigin)
    return parsed.origin === baseOrigin && /^\/api\/local-files\/verified\/[^/]+$/.test(parsed.pathname)
  } catch {
    return false
  }
}

function VerifiedLocalHtmlPreview({ file, t, url }) {
  const [state, setState] = useState({ url: '', errorCode: '' })
  const [retryVersion, setRetryVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let activePreviewUrl = ''
    createLocalHtmlPreviewSession(url, { signal: controller.signal }).then((previewUrl) => {
      activePreviewUrl = previewUrl
      if (disposed) {
        void revokeLocalHtmlPreviewSession(previewUrl).catch(() => {})
        return
      }
      setState({ url: previewUrl, errorCode: '' })
    }).catch((cause) => {
      if (!disposed && cause?.name !== 'AbortError') {
        setState({
          url: '',
          errorCode: String(cause?.code || 'LOCAL_HTML_PREVIEW_SESSION_FAILED'),
        })
      }
    })
    return () => {
      disposed = true
      controller.abort()
      if (activePreviewUrl) void revokeLocalHtmlPreviewSession(activePreviewUrl).catch(() => {})
    }
  }, [retryVersion, url])

  if (state.errorCode) {
    const serviceUnavailable = [
      'LOCAL_HTML_PREVIEW_NOT_READY',
      'LOCAL_HTML_PREVIEW_RUNTIME_MISMATCH',
      'LOCAL_HTML_PREVIEW_ROUTE_UNAVAILABLE',
    ].includes(state.errorCode)
    const detailKey = serviceUnavailable
      ? 'chatPreview.localHtmlServiceUnavailable'
      : 'chatPreview.previewRetryHint'
    return <PreviewStatus
      icon={<AlertCircle className="h-6 w-6" />}
      text={t('chatPreview.previewFailed')}
      detail={t(detailKey)}
      action={(
        <button
          type="button"
          onClick={() => setRetryVersion((value) => value + 1)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 bg-paper px-3 text-xs font-medium text-ink-soft hover:bg-paper-2 hover:text-ink"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('chatPreview.retryPreview')}
        </button>
      )}
    />
  }
  if (!state.url) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  return <DirectHtmlUrlPreview file={file} t={t} url={state.url} />
}

function ManagedHtmlArtifactPreview({ file, t, url }) {
  const [state, setState] = useState({ html: '', error: '' })
  useEffect(() => {
    const controller = new AbortController()
    let objectUrls = []
    loadArtifactPreviewDocument(url, { signal: controller.signal }).then((document) => {
      if (controller.signal.aborted) {
        for (const objectUrl of document.objectUrls) URL.revokeObjectURL?.(objectUrl)
        return
      }
      objectUrls = document.objectUrls
      setState({ html: applyHtmlArtifactDocumentPolicy(document.html), error: '' })
    }).catch((cause) => {
      if (!controller.signal.aborted) setState({ html: '', error: cause?.message || String(cause) })
    })
    return () => {
      controller.abort()
      for (const objectUrl of objectUrls) URL.revokeObjectURL?.(objectUrl)
    }
  }, [url])
  return (
    <div className="relative h-full min-h-0 bg-white">
      {state.html && <iframe
        srcDoc={state.html}
        title={file.filename || file.title || t('chatPreview.htmlTitle')}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="block h-full w-full border-0 bg-white"
      />}
      {!state.html && !state.error && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {state.error && <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')} detail={state.error} />}
    </div>
  )
}

function DirectHtmlUrlPreview({ file, t, url }) {
  const [status, setStatus] = useState('loading')
  return (
    <div className="relative h-full min-h-0 bg-white">
      <iframe
        src={url}
        title={file.filename || file.title || t('chatPreview.htmlTitle')}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('failed')}
        className={`${status === 'failed' ? 'hidden' : 'block'} h-full w-full border-0 bg-white`}
      />
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {status === 'failed' && <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')} detail={t('chatPreview.unsupportedHint')} />}
    </div>
  )
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

function PreviewStatus({ icon, text, detail = '', action = null }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center text-ink-fade" role="status">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ink/10 bg-paper shadow-sm">{icon}</span>
      <p className="max-w-sm text-sm font-medium text-ink-soft">{text}</p>
      {detail && <p className="max-w-sm break-words text-xs leading-relaxed text-ink-fade">{detail}</p>}
      {action}
    </div>
  )
}
