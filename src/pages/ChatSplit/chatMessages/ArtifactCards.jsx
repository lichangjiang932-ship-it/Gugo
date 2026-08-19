import { BarChart3, Code2, Download, ExternalLink, FileText, LayoutList } from 'lucide-react'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { artifactHasInlineReference, artifactReferenceOpenPayload, buildServerArtifactReferences, resolveDeliveryArtifacts } from '../../../lib/artifactReferences.js'
import { mergeArtifactReferences, verifiedLocalFileOpenPayload } from '../../../lib/localFileReferences.js'
import { withDownloadToken } from '../../../lib/jobClient.js'

export function ArtifactReferenceLinks({ msg, preview, onOpen, referenceContent, verifiedLocalFileReferences = [] }) {
  const source = String(msg?.meta?.artifactSource || msg?.content || '')
  const serverReferences = buildServerArtifactReferences({
    artifacts: resolveDeliveryArtifacts(msg?.meta),
    content: source,
    messageId: msg?.id,
    preview,
  })
  const allReferences = mergeArtifactReferences({
    serverReferences,
    verifiedLocalFileReferences,
  })
  const visibleContent = referenceContent === undefined ? msg?.content : referenceContent
  const references = allReferences.filter((reference) => (
    reference.url && !artifactHasInlineReference(visibleContent, reference, allReferences)
  ))
  if (references.length === 0) return null

  const openReference = (event, reference) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const artifact = verifiedLocalFileOpenPayload(reference)
      || artifactReferenceOpenPayload(reference, msg?.id)
    if (!artifact || typeof onOpen !== 'function') return
    event.preventDefault()
    onOpen(artifact)
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="artifact-reference-links" data-artifact-surface="delivery-links">
      {references.map((reference) => (
        <a
          key={reference.identity || reference.id || reference.url || reference.filename}
          href={withDownloadToken(reference.url)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="artifact-open-card"
          onClick={(event) => openReference(event, reference)}
          className="inline-flex max-w-full items-center gap-2 rounded-control border border-ink-fade/30 bg-paper px-2.5 py-1.5 text-left text-sm font-medium text-ink transition-colors hover:border-ink-fade/60 hover:bg-ink-ghost"
          title={reference.filename}
        >
          <FileText className="h-4 w-4 shrink-0 text-ink-fade" />
          <span className="chat-output-file-name truncate">{reference.filename}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </a>
      ))}
    </div>
  )
}

export function ServerArtifactCards({ artifacts = [] }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null
  return <div className="mt-3 space-y-2" data-testid="server-turn-artifacts" data-artifact-surface="server-artifacts">{artifacts.map((artifact) => <a key={artifact.id || artifact.url} href={withDownloadToken(artifact.url)} download={artifact.filename || ''} className="flex items-center gap-3 rounded-card border border-ink/10 bg-paper p-3 transition-colors hover:border-ink/20 hover:bg-paper-2/45"><span className="flex h-9 w-9 items-center justify-center rounded-control bg-ink/[0.055] text-ink-fade"><FileText className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="chat-output-file-name block truncate text-sm font-medium text-ink">{artifact.filename || artifact.title || 'artifact'}</span><span className="block text-xs text-ink-fade">{artifact.type || 'file'}</span></span><Download className="h-4 w-4 text-ink-fade" /></a>)}</div>
}

export function ArtifactOpenCard({ preview, onOpen, className = '' }) {
  const { t } = useT()
  if (!preview) return null
  return <button type="button" data-testid="artifact-open-card" data-artifact-surface="artifact-card" onClick={onOpen} className={`group flex w-full items-center gap-3 rounded-card border border-ink/10 bg-paper p-3 text-left shadow-sm transition-[background-color,border-color,box-shadow,transform] hover:-translate-y-px hover:border-ink/20 hover:bg-paper-2/45 hover:shadow-md ${className}`} title={`${preview.label} · ${t('chatPreview.preview')}`}><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-ink/10 bg-ink/[0.045] text-ink-fade"><PreviewIcon type={preview.type} /></div><div className="min-w-0 flex-1"><div className="font-mono text-xs uppercase tracking-[0.18em] text-ink-fade">{preview.label}</div><div className="chat-output-file-name truncate text-sm font-semibold text-ink" title={preview.filename}>{preview.filename}</div><div className="truncate text-xs text-ink-fade">{preview.summary}</div></div><div className="inline-flex shrink-0 items-center gap-1.5"><span className="hidden text-xs text-ink-fade group-hover:text-ink sm:inline">{t('chatPreview.preview')}</span><ExternalLink className="h-4 w-4 text-ink-fade group-hover:text-ink" /></div></button>
}

function PreviewIcon({ type }) {
  if (type === 'docx') return <FileText className="w-5 h-5" />
  if (type === 'xlsx') return <LayoutList className="w-5 h-5" />
  if (['html', 'html_multi'].includes(type)) return <ExternalLink className="w-5 h-5" />
  if (['svg', 'react'].includes(type)) return <Code2 className="w-5 h-5" />
  return <BarChart3 className="w-5 h-5" />
}
