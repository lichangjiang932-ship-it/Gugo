import { BarChart3, Code2, Download, ExternalLink, FileText, LayoutList } from 'lucide-react'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { artifactHasInlineReference, artifactReferenceOpenPayload, buildArtifactReferenceIdentity, buildServerArtifactReferences, resolveDeliveryArtifacts } from '../../../lib/artifactReferences.js'
import { withDownloadToken } from '../../../lib/jobClient.js'

export function ArtifactReferenceLinks({ msg, preview, onOpen }) {
  const source = String(msg?.meta?.artifactSource || msg?.content || '')
  const allReferences = buildServerArtifactReferences({
    artifacts: resolveDeliveryArtifacts(msg?.meta),
    content: source,
    messageId: msg?.id,
    preview,
  })
  const references = allReferences.filter((reference) => !artifactHasInlineReference(msg?.content, reference))
  const previewAlreadyRepresented = allReferences.some((reference) => reference.previewArtifact)
  if (preview && !previewAlreadyRepresented && !artifactHasInlineReference(msg?.content, preview)) {
    const identity = buildArtifactReferenceIdentity({ filename: preview.filename, messageId: msg?.id, type: preview.type })
    references.unshift({
      id: `${msg?.id || 'artifact'}-preview`,
      identity,
      filename: preview.filename,
      type: preview.type,
      previewArtifact: { messageId: String(msg?.id || ''), artifactIdentity: identity, content: source, preview },
    })
  }
  if (references.length === 0) return null

  const openReference = (reference) => {
    const artifact = artifactReferenceOpenPayload(reference, msg?.id)
    onOpen?.(artifact)
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="artifact-reference-links">
      {references.map((reference) => (
        <button
          key={reference.identity || reference.id || reference.url || reference.filename}
          type="button"
          data-testid="artifact-open-card"
          onClick={() => openReference(reference)}
          className="inline-flex max-w-full items-center gap-2 rounded-md border border-ember/30 bg-ember-soft px-2.5 py-1.5 text-left text-sm font-medium text-ember transition-colors hover:border-ember/60 hover:bg-ember/10"
          title={reference.filename}
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{reference.filename}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </button>
      ))}
    </div>
  )
}

export function ServerArtifactCards({ artifacts = [] }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null
  return <div className="mt-3 space-y-2" data-testid="server-turn-artifacts">{artifacts.map((artifact) => <a key={artifact.id || artifact.url} href={withDownloadToken(artifact.url)} download={artifact.filename || ''} className="flex items-center gap-3 rounded-md border border-ink-fade/30 bg-paper p-3 transition-colors hover:border-ember/60"><span className="flex h-9 w-9 items-center justify-center rounded-md bg-ember-soft text-ember"><FileText className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.filename || artifact.title || 'artifact'}</span><span className="block text-xs text-ink-fade">{artifact.type || 'file'}</span></span><Download className="h-4 w-4 text-ink-fade" /></a>)}</div>
}

export function ArtifactOpenCard({ preview, onOpen, className = '' }) {
  const { t } = useT()
  if (!preview) return null
  return <button type="button" data-testid="artifact-open-card" onClick={onOpen} className={`group w-full text-left rounded-md border border-ink-fade/30 bg-paper hover:border-ember/60 hover:shadow-sm transition-all p-3 flex items-center gap-3 ${className}`} title={`${preview.label} · ${t('chatPreview.preview')}`}><div className="w-10 h-10 rounded-md bg-ember-soft border border-ember/30 flex items-center justify-center text-ember shrink-0"><PreviewIcon type={preview.type} /></div><div className="min-w-0 flex-1"><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">{preview.label}</div><div className="font-semibold text-ink text-sm truncate" title={preview.filename}>{preview.filename}</div><div className="text-xs text-ink-fade truncate">{preview.summary}</div></div><div className="shrink-0 inline-flex items-center gap-1.5"><span className="text-[11px] text-ink-fade group-hover:text-ember hidden sm:inline">{t('chatPreview.preview')}</span><ExternalLink className="w-4 h-4 text-ink-fade group-hover:text-ember" /></div></button>
}

function PreviewIcon({ type }) {
  if (type === 'docx') return <FileText className="w-5 h-5" />
  if (type === 'xlsx') return <LayoutList className="w-5 h-5" />
  if (['html', 'html_multi'].includes(type)) return <ExternalLink className="w-5 h-5" />
  if (['svg', 'react'].includes(type)) return <Code2 className="w-5 h-5" />
  return <BarChart3 className="w-5 h-5" />
}
