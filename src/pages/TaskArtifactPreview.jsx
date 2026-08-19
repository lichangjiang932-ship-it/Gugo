import { useEffect, useState } from 'react'
import { AlertCircle, Code2, Download, FileText, Globe, Loader2, Presentation, Table2, X } from 'lucide-react'
import { applyHtmlArtifactDocumentPolicy } from '../../shared/htmlArtifactPolicy.js'
import { loadArtifactPreviewDocument, withDownloadToken } from '../lib/jobClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

function TypeIcon({ type }) {
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'docx') return <FileText className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  if (type === 'html') return <Globe className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

export default function TaskArtifactPreview({ artifact, onClose }) {
  const { t } = useT()
  const artifactUrl = String(artifact?.url || '')
  const isInlineHtml = artifact?.type === 'html'
  const requestKey = `${artifact?.id || ''}:${artifactUrl}`
  const [loadState, setLoadState] = useState(() => ({ key: '', html: '', objectUrls: [], error: '' }))
  const [loadedKey, setLoadedKey] = useState('')

  useEffect(() => {
    if (!isInlineHtml || !artifactUrl) return undefined
    const controller = new AbortController()
    let objectUrls = []
    loadArtifactPreviewDocument(artifactUrl, { signal: controller.signal }).then((document) => {
      objectUrls = document.objectUrls
      if (!controller.signal.aborted) setLoadState({ key: requestKey, html: document.html, objectUrls, error: '' })
    }).catch((cause) => {
      if (!controller.signal.aborted) setLoadState({ key: requestKey, html: '', objectUrls: [], error: cause?.message || String(cause) })
    })
    return () => {
      controller.abort()
      for (const objectUrl of objectUrls) URL.revokeObjectURL?.(objectUrl)
    }
  }, [artifactUrl, isInlineHtml, requestKey])

  const currentLoadState = loadState.key === requestKey ? loadState : null
  const previewHtml = currentLoadState?.html ? applyHtmlArtifactDocumentPolicy(currentLoadState.html) : ''
  const previewError = isInlineHtml && (!artifactUrl || currentLoadState?.error)
  const loading = isInlineHtml && !previewError && (!previewHtml || loadedKey !== requestKey)

  if (!artifact) return null

  const downloadUrl = withDownloadToken(artifact.url)

  return (
    <aside
      className="border-l border-dashed border-ink-fade/40 bg-paper flex flex-col min-w-0"
      style={{ width: 460 }}
      aria-label={t('artifact.taskPreview')}
    >
      <header className="px-4 py-3 border-b border-dashed border-ink-fade/40 flex items-center gap-2">
        <TypeIcon type={artifact.type} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-ink truncate">{artifact.title || artifact.filename || t('artifact.unnamed')}</p>
          <p className="font-mono text-[10px] text-ink-fade uppercase tracking-wider">
            {artifact.type || 'file'} · {artifact.filename || '—'}
          </p>
        </div>
        <a
          href={downloadUrl}
          download={artifact.filename || ''}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-contrast text-xs"
        >
          <Download className="w-3.5 h-3.5" />
          {t('artifact.download')}
        </a>
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-ink/20 text-ink-soft"
          aria-label={t('artifact.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {isInlineHtml && previewHtml ? (
          <iframe
            title={t('artifact.previewTitle', { title: artifact.title || '' })}
            srcDoc={previewHtml}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="w-full h-full border-0 bg-white"
            onLoad={() => setLoadedKey(requestKey)}
          />
        ) : previewError ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-ink-soft" role="status">
            <AlertCircle className="w-5 h-5 text-ink-fade" />
            <p className="text-sm">{t('chatPreview.previewFailed')}</p>
          </div>
        ) : !isInlineHtml ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-ink-soft">
            <TypeIcon type={artifact.type} />
            <p className="text-sm">
              {artifact.type === 'pptx' && t('artifact.pptxHint')}
              {artifact.type === 'docx' && t('artifact.docxHint')}
              {artifact.type === 'xlsx' && t('artifact.xlsxHint')}
              {!['pptx', 'docx', 'xlsx'].includes(artifact.type) && t('artifact.unsupportedHint')}
            </p>
            <a
              href={downloadUrl}
              download={artifact.filename || ''}
              className="h-9 px-4 inline-flex items-center gap-1.5 rounded-md bg-ink text-paper text-sm"
            >
              <Download className="w-4 h-4" />
              {t('artifact.download')} {artifact.filename || ''}
            </a>
          </div>
        ) : null}
        {loading && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-paper/70">
            <Loader2 className="w-5 h-5 animate-spin text-ink-fade" />
          </div>
        )}
      </div>
    </aside>
  )
}
