import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileText, LoaderCircle } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import { classifyDirectFile, loadDirectFilePreview } from '../../../lib/directFilePreview.js'
import { DocxPreview, PptxPreview, SourceView, XlsxPreview } from './ArtifactRenderers.jsx'
import { InteractiveHtmlFilePreview } from './HtmlFilePreview.jsx'
import { NativePreviewRenderer, WorkbookPreview } from './NativePreviewRenderers.jsx'
import { OpenOriginalLink, PreviewFallbackActions, PreviewStatus } from './PreviewPrimitives.jsx'
import { previewRendererRegistry } from './previewRendererRegistry.js'
import { withPreviewRetry } from './previewUrl.js'

export { DirectHtmlUrlPreview } from './HtmlFilePreview.jsx'

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
