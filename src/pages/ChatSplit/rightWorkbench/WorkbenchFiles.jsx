import { Download, Eye, FileText, Files } from 'lucide-react'
import { classifyDirectFile, withArtifactPreviewMode } from '../../../lib/directFilePreview.js'
import { withDownloadToken } from '../../../lib/jobClient.js'

function FileVisual({ artifact }) {
  if (classifyDirectFile(artifact) !== 'image' || !artifact.url) return <FileText className="h-3.5 w-3.5" />
  return <img src={withArtifactPreviewMode(withDownloadToken(artifact.url))} alt="" loading="lazy"
    referrerPolicy="no-referrer" className="h-full w-full rounded-control object-cover" />
}

function openArtifact(event, onOpenArtifact, artifact) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (typeof onOpenArtifact !== 'function') return
  event.preventDefault()
  onOpenArtifact(artifact.previewArtifact || { messageId: artifact.messageId || '', content: '', preview: null, directFile: artifact })
}

function FileRow({ artifact, onOpenArtifact, t }) {
  const filename = artifact.filename || t('workbench.untitledArtifact')
  const snapshot = artifact.previewArtifact?.preview && !artifact.previewArtifact?.directFile
  return (
    <div className="group flex w-full items-center rounded-control transition-colors hover:bg-ink/5">
      <a href={withArtifactPreviewMode(withDownloadToken(artifact.url))} target="_blank" rel="noopener noreferrer"
        data-testid="workbench-file-open" aria-label={t('workbench.previewFile', { filename })}
        onClick={(event) => openArtifact(event, onOpenArtifact, artifact)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-control bg-ink/5 text-ink-fade"><FileVisual artifact={artifact} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{filename}</span>
          <span className="mt-0.5 block truncate text-xs uppercase tracking-wide text-ink-fade">{artifact.type || t('workbench.fileType')}</span>
          {artifact.path && <span className="mt-0.5 block truncate text-xs text-ink-fade" title={artifact.path}>{artifact.path}</span>}
          {snapshot && <span className="block text-xs text-ink-fade">{t('workbench.fileSnapshot')}</span>}
          {artifact.verificationPending && <span className="block text-xs text-ink-fade">{t('workbench.fileVerificationPending')}</span>}
        </span>
        <Eye className="h-3.5 w-3.5 text-ink-fade" aria-hidden="true" />
      </a>
      {!snapshot && <a href={withDownloadToken(artifact.url)} download={artifact.filename || ''}
        aria-label={t('chatPreview.download', { filename })} title={t('chatPreview.download', { filename })}
        className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:bg-paper hover:text-accent-ink">
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </a>}
    </div>
  )
}

export default function WorkbenchFiles({ artifacts, onOpenArtifact, t }) {
  const groups = [
    { key: 'outputs', title: 'workbench.outputFiles', files: artifacts.filter((file) => !file.userAttachment) },
    { key: 'sources', title: 'workbench.sourceFiles', files: artifacts.filter((file) => file.userAttachment) },
  ]
  return (
    <section data-testid="workbench-files" data-artifact-surface="workbench-files" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <p className="mb-3 px-1 text-xs leading-5 text-ink-fade">{t('workbench.filesHint')}</p>
      {artifacts.length === 0 ? (
        <div className="flex h-44 flex-col items-center justify-center gap-2 text-ink-fade"><Files className="h-7 w-7 opacity-30" /><span className="text-xs">{t('workbench.noFiles')}</span></div>
      ) : groups.filter((group) => group.files.length > 0).map((group) => (
        <section key={group.key} data-testid={`workbench-${group.key}`} className="mb-4">
          <h3 className="mb-1 px-1 text-xs font-semibold text-ink">{t(group.title)}</h3>
          {group.files.map((artifact) => <FileRow key={artifact.id} artifact={artifact} onOpenArtifact={onOpenArtifact} t={t} />)}
        </section>
      ))}
    </section>
  )
}
