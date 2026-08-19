import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, FileText, LoaderCircle, RefreshCw } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import { classifyDirectFile, loadDirectFilePreview } from '../../../lib/directFilePreview.js'
import {
  createArtifactHtmlPreviewSession,
  createLocalHtmlPreviewSession,
  probeHtmlPreviewSession,
  revokeArtifactHtmlPreviewSession,
  revokeLocalHtmlPreviewSession,
} from '../../../lib/jobClient.js'
import { DocxPreview, PptxPreview, SourceView, XlsxPreview } from './ArtifactRenderers.jsx'
import { previewRendererRegistry } from './previewRendererRegistry.js'

function directFilePreviewIdentity(file = {}, url = '') {
  return [file.id, file.filename, file.title, file.type, file.mimeType, file.path, url]
    .map((value) => String(value || ''))
    .join('\u0000')
}

export default function DirectFilePreview(props) {
  return <DirectFilePreviewRequest key={directFilePreviewIdentity(props.file, props.url)} {...props} />
}

function DirectFilePreviewRequest({ file, url, t }) {
  const filename = String(file?.filename || '')
  const title = String(file?.title || '')
  const type = String(file?.type || '')
  const mimeType = String(file?.mimeType || '')
  const previewFile = useMemo(() => ({ filename, title, type, mimeType }), [filename, mimeType, title, type])
  const kind = classifyDirectFile(previewFile)
  const initialRenderer = previewRendererRegistry.resolve(kind) || previewRendererRegistry.resolve('unsupported')
  const needsFetch = initialRenderer?.needsFetch === true
  const [retryAttempt, setRetryAttempt] = useState(0)
  const requestUrl = needsFetch ? withPreviewRetry(url, retryAttempt) : url
  const requestKey = `${kind}:${requestUrl}:${filename}:${mimeType}:${retryAttempt}`
  const [loadState, setLoadState] = useState(() => ({ key: '', preview: null, error: '' }))

  useEffect(() => {
    if (!needsFetch) return undefined
    const controller = new AbortController()
    loadDirectFilePreview({
      file: previewFile,
      url: requestUrl,
      fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    }).then((result) => {
      if (!controller.signal.aborted) setLoadState({ key: requestKey, preview: result, error: '' })
    }).catch((cause) => {
      if (!controller.signal.aborted) setLoadState({ key: requestKey, preview: null, error: cause?.message || String(cause) })
    })
    return () => controller.abort()
  }, [needsFetch, previewFile, requestKey, requestUrl])

  const currentLoadState = loadState.key === requestKey ? loadState : null
  const preview = needsFetch ? currentLoadState?.preview : { kind, url }
  const loading = needsFetch && !currentLoadState
  const error = currentLoadState?.error || ''

  if (loading) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  if (error) return <PreviewStatus
    icon={<AlertCircle className="h-6 w-6" />}
    text={t('chatPreview.previewFailed')}
    detail={error}
    action={<PreviewFallbackActions onRetry={() => setRetryAttempt((value) => value + 1)} t={t} url={url} />}
  />
  const descriptor = previewRendererRegistry.resolve(preview?.kind) || previewRendererRegistry.resolve('unsupported')
  const Renderer = descriptor.component
  return <Renderer preview={preview} file={file} url={url} t={t} />
}

function NativePreviewRenderer({ file, preview, t, url }) {
  return <NativeFilePreview key={`${preview.kind}:${url}`} kind={preview.kind} file={file} url={url} t={t} />
}

function HtmlPreviewRenderer({ file, t, url }) {
  return <InteractiveHtmlFilePreview key={`html:${url}`} file={file} url={url} t={t} />
}

function DocxFileRenderer({ preview }) {
  return <DocxPreview blocks={preview.blocks || []} title={preview.title} />
}

function PptxFileRenderer({ preview }) {
  return <PptxPreview content={preview.content || ''} />
}

function WorkbookFileRenderer({ preview }) {
  return <WorkbookPreview sheets={preview.sheets || []} />
}

function CsvFileRenderer({ preview }) {
  return <XlsxPreview rows={preview.rows || []} />
}

function MarkdownFileRenderer({ preview }) {
  return <div className="h-full overflow-auto bg-paper px-6 py-5"><MarkdownRenderer>{preview.text}</MarkdownRenderer></div>
}

function SourceFileRenderer({ preview }) {
  return <SourceView content={preview.text || ''} />
}

function UnsupportedFileRenderer({ file, t, url }) {
  return <PreviewStatus
    icon={<FileText className="h-6 w-6" />}
    text={file.filename || file.title || 'artifact'}
    detail={t('chatPreview.unsupportedHint')}
    action={<OpenOriginalLink url={url} t={t} />}
  />
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
  if (isLocalReceiptFileUrl(url)) {
    return <LocalReceiptHtmlPreview file={file} t={t} url={url} />
  }
  return <DirectHtmlUrlPreview file={file} t={t} url={url} />
}

function isLocalReceiptFileUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(raw, baseOrigin)
    return parsed.origin === baseOrigin
      && /^\/api\/local-files\/(?:verified|retained)\/[^/]+$/.test(parsed.pathname)
  } catch {
    return false
  }
}

async function issueUsableHtmlPreviewSession({ createSession, revokeSession, signal }) {
  let previewUrl = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    previewUrl = await createSession({ signal })
    if (signal.aborted) {
      await revokeSession(previewUrl).catch(() => {})
      throw signal.reason || new DOMException('Aborted', 'AbortError')
    }
    try {
      await probeHtmlPreviewSession(previewUrl, { signal })
      return previewUrl
    } catch (cause) {
      await revokeSession(previewUrl).catch(() => {})
      previewUrl = ''
      if (signal.aborted || cause?.name === 'AbortError' || attempt === 1) throw cause
    }
  }
  return previewUrl
}

function LocalReceiptHtmlPreview({ file, t, url }) {
  const [state, setState] = useState({ url: '', error: null })
  const [retryVersion, setRetryVersion] = useState(0)
  const retry = () => {
    setState({ url: '', error: null })
    setRetryVersion((value) => value + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let activePreviewUrl = ''
    issueUsableHtmlPreviewSession({
      createSession: ({ signal }) => createLocalHtmlPreviewSession(url, { signal }),
      revokeSession: revokeLocalHtmlPreviewSession,
      signal: controller.signal,
    }).then((previewUrl) => {
      activePreviewUrl = previewUrl
      if (disposed) {
        void revokeLocalHtmlPreviewSession(previewUrl).catch(() => {})
        return
      }
      setState({ url: previewUrl, error: null })
    }).catch((cause) => {
      if (!disposed && cause?.name !== 'AbortError') {
        setState({
          url: '',
          error: {
            code: String(cause?.code || 'LOCAL_HTML_PREVIEW_SESSION_FAILED'),
            message: String(cause?.message || ''),
            hint: String(cause?.hint || ''),
          },
        })
      }
    })
    return () => {
      disposed = true
      controller.abort()
      if (activePreviewUrl) void revokeLocalHtmlPreviewSession(activePreviewUrl).catch(() => {})
    }
  }, [retryVersion, url])

  if (state.error) {
    const serviceUnavailable = [
      'LOCAL_HTML_PREVIEW_NOT_READY',
      'LOCAL_HTML_PREVIEW_RUNTIME_MISMATCH',
      'LOCAL_HTML_PREVIEW_ROUTE_UNAVAILABLE',
    ].includes(state.error.code)
    const detailKey = serviceUnavailable
      ? 'chatPreview.localHtmlServiceUnavailable'
      : 'chatPreview.previewRetryHint'
    const structuredDetail = [state.error.message, state.error.hint]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' ')
    return <PreviewStatus
      icon={<AlertCircle className="h-6 w-6" />}
      text={t('chatPreview.previewFailed')}
      detail={serviceUnavailable ? t(detailKey) : (structuredDetail || t(detailKey))}
      errorCode={state.error.code}
      action={<RetryPreviewButton onClick={retry} t={t} />}
    />
  }
  if (!state.url) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  return <DirectHtmlUrlPreview file={file} t={t} url={state.url} onRetry={retry} />
}

function ManagedHtmlArtifactPreview({ file, t, url }) {
  const [state, setState] = useState({ url: '', error: null })
  const [retryVersion, setRetryVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let activePreviewUrl = ''
    issueUsableHtmlPreviewSession({
      createSession: ({ signal }) => createArtifactHtmlPreviewSession(url, { signal }),
      revokeSession: revokeArtifactHtmlPreviewSession,
      signal: controller.signal,
    }).then((previewUrl) => {
      activePreviewUrl = previewUrl
      if (disposed) {
        void revokeArtifactHtmlPreviewSession(previewUrl).catch(() => {})
        return
      }
      setState({ url: previewUrl, error: null })
    }).catch((cause) => {
      if (!disposed && cause?.name !== 'AbortError') {
        setState({
          url: '',
          error: {
            code: String(cause?.code || 'ARTIFACT_HTML_PREVIEW_SESSION_FAILED'),
            message: String(cause?.message || cause || ''),
            hint: String(cause?.hint || ''),
          },
        })
      }
    })
    return () => {
      disposed = true
      controller.abort()
      if (activePreviewUrl) void revokeArtifactHtmlPreviewSession(activePreviewUrl).catch(() => {})
    }
  }, [retryVersion, url])

  const retry = () => {
    setState({ url: '', error: null })
    setRetryVersion((value) => value + 1)
  }
  if (state.error) {
    const detail = [state.error.message, state.error.hint]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' ')
    return <PreviewStatus
      icon={<AlertCircle className="h-6 w-6" />}
      text={t('chatPreview.previewFailed')}
      detail={detail || t('chatPreview.previewRetryHint')}
      errorCode={state.error.code}
      action={<RetryPreviewButton onClick={retry} t={t} />}
    />
  }
  if (!state.url) return <PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} />
  return <DirectHtmlUrlPreview allowScripts file={file} t={t} url={state.url} onRetry={retry} />
}

export function DirectHtmlUrlPreview({ allowScripts = false, file, onRetry, t, timeoutMs = 5_000, url }) {
  const [attempt, setAttempt] = useState(0)
  const requestUrl = withPreviewRetry(url, attempt)
  const requestKey = `${requestUrl}:${attempt}`
  const [loadState, setLoadState] = useState({ key: '', status: 'loading' })
  const status = loadState.key === requestKey ? loadState.status : 'loading'
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoadState((current) => (
        current.key === requestKey && current.status === 'ready'
          ? current
          : { key: requestKey, status: 'failed' }
      ))
    }, Math.max(0, Number(timeoutMs) || 0))
    return () => clearTimeout(timer)
  }, [requestKey, timeoutMs])

  const retry = () => {
    if (typeof onRetry === 'function') {
      onRetry()
      return
    }
    setAttempt((value) => value + 1)
  }
  return (
    <div className="relative h-full min-h-0 bg-white">
      <iframe
        key={requestKey}
        src={requestUrl}
        title={file.filename || file.title || t('chatPreview.htmlTitle')}
        sandbox={allowScripts ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        onLoad={() => setLoadState({ key: requestKey, status: 'ready' })}
        onError={() => setLoadState({ key: requestKey, status: 'failed' })}
        className={`${status === 'failed' ? 'hidden' : 'block'} h-full w-full border-0 bg-white`}
      />
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {status === 'failed' && <PreviewStatus
        icon={<AlertCircle className="h-6 w-6" />}
        text={t('chatPreview.previewFailed')}
        detail={t('chatPreview.previewRetryHint')}
        action={<PreviewFallbackActions onRetry={retry} t={t} url={url} />}
      />}
    </div>
  )
}

function RetryPreviewButton({ onClick, t }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 bg-paper px-3 text-xs font-medium text-ink-soft hover:bg-paper-2 hover:text-ink"
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {t('chatPreview.retryPreview')}
    </button>
  )
}

function OpenOriginalLink({ t, url }) {
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 bg-paper px-3 text-xs font-medium text-ink-soft hover:bg-paper-2 hover:text-ink"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {t('chatPreview.openOriginal')}
    </a>
  )
}

function PreviewFallbackActions({ onRetry, t, url }) {
  return (
    <span className="flex flex-wrap items-center justify-center gap-2">
      <RetryPreviewButton onClick={onRetry} t={t} />
      <OpenOriginalLink url={url} t={t} />
    </span>
  )
}

function withPreviewRetry(url, attempt) {
  if (!attempt || !url || /^(?:data|blob):/i.test(url)) return url
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(url, baseOrigin)
    parsed.searchParams.set('previewRetry', String(attempt))
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return parsed.href
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    const hashIndex = url.indexOf('#')
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
    return `${base}${base.includes('?') ? '&' : '?'}previewRetry=${attempt}${hash}`
  }
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
      {kind === 'image' && <img key={attempt} src={requestUrl} alt={file.filename || file.title || ''} onLoad={ready} onError={failed} referrerPolicy="no-referrer" className={`${status === 'failed' ? 'hidden' : 'block'} max-h-full max-w-full rounded-sm object-contain shadow-sm`} />}
      {kind === 'pdf' && <iframe key={attempt} src={requestUrl} title={file.filename || file.title || 'PDF'} onLoad={ready} onError={failed} referrerPolicy="no-referrer" className={`${status === 'failed' ? 'hidden' : 'block'} h-full w-full border-0 bg-white`} />}
      {kind === 'audio' && <audio key={attempt} controls preload="metadata" src={requestUrl} onLoadedMetadata={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} w-full max-w-xl`} />}
      {kind === 'video' && <video key={attempt} controls preload="metadata" src={requestUrl} onLoadedMetadata={ready} onError={failed} className={`${status === 'failed' ? 'hidden' : 'block'} max-h-full max-w-full`} />}
      {status === 'loading' && <div className="absolute inset-0 flex items-center justify-center bg-paper-2/90"><PreviewStatus icon={<LoaderCircle className="h-6 w-6 animate-spin" />} text={t('chatPreview.loadingFile')} /></div>}
      {status === 'failed' && <PreviewStatus icon={<AlertCircle className="h-6 w-6" />} text={t('chatPreview.previewFailed')} detail={t('chatPreview.unsupportedHint')} action={<PreviewFallbackActions onRetry={retry} t={t} url={url} />} />}
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
          {sheets.map((sheet, index) => <button key={`${index}-${sheet.name}`} type="button" onClick={() => setActiveIndex(index)} className={`h-7 shrink-0 rounded-md px-2.5 text-xs ${index === safeActiveIndex ? 'bg-paper font-medium text-ink shadow-sm' : 'text-ink-fade hover:text-ink'}`}>{sheet.name}</button>)}
        </div>
      )}
      <div className="min-h-0 flex-1"><XlsxPreview rows={active.rows || []} /></div>
    </div>
  )
}

function PreviewStatus({ icon, text, detail = '', action = null, errorCode = '' }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center text-ink-fade" role="status" data-error-code={errorCode || undefined}>
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ink/10 bg-paper shadow-sm">{icon}</span>
      <p className="max-w-sm text-sm font-medium text-ink-soft">{text}</p>
      {detail && <p className="max-w-sm break-words text-xs leading-relaxed text-ink-fade">{detail}</p>}
      {action}
    </div>
  )
}

const builtInPreviewRendererCleanups = [
  ['image', { component: NativePreviewRenderer }],
  ['pdf', { component: NativePreviewRenderer }],
  ['audio', { component: NativePreviewRenderer }],
  ['video', { component: NativePreviewRenderer }],
  ['html', { component: HtmlPreviewRenderer }],
  ['docx', { component: DocxFileRenderer, needsFetch: true }],
  ['pptx', { component: PptxFileRenderer, needsFetch: true }],
  ['xlsx', { component: WorkbookFileRenderer, needsFetch: true }],
  ['csv', { component: CsvFileRenderer, needsFetch: true }],
  ['markdown', { component: MarkdownFileRenderer, needsFetch: true }],
  ['json', { component: SourceFileRenderer, needsFetch: true }],
  ['xml', { component: SourceFileRenderer, needsFetch: true }],
  ['code', { component: SourceFileRenderer, needsFetch: true }],
  ['text', { component: SourceFileRenderer, needsFetch: true }],
  ['unsupported', { component: UnsupportedFileRenderer }],
].map(([kind, descriptor]) => previewRendererRegistry.register(kind, descriptor))

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const unregister of builtInPreviewRendererCleanups) unregister()
  })
}
