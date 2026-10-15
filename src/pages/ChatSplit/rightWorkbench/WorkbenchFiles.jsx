import { useState } from 'react'
import { Download, Eye, FileText, Files, Menu } from 'lucide-react'
import { classifyDirectFile, withArtifactPreviewMode } from '../../../lib/directFilePreview.js'
import { withDownloadToken } from '../../../lib/jobClient.js'
import CurrentFileChange from '../../../components/CurrentFileChange.jsx'
import FileIdentity from '../preview/FileIdentity.jsx'
import FileNameLabel from '../../../components/FileNameLabel.jsx'
import FileListOverlay from './diffReview/FileListOverlay.jsx'

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

function FileRow({ artifact, onOpenArtifact, onSelect, selected = false, t }) {
  const filename = artifact.filename || t('workbench.untitledArtifact')
  const snapshot = artifact.previewArtifact?.preview && !artifact.previewArtifact?.directFile
  return (
    <div
      data-selected={selected || undefined}
      className="group flex w-full cursor-pointer items-center rounded-control transition-colors hover:bg-[var(--color-row-hover)]"
      data-testid="workbench-file-row"
      onClick={() => onSelect?.()}
    >
      <a href={withArtifactPreviewMode(withDownloadToken(artifact.url))} target="_blank" rel="noopener noreferrer"
        data-testid="workbench-file-open" aria-label={t('workbench.previewFile', { filename })}
        onClick={(event) => openArtifact(event, onOpenArtifact, artifact)}
        className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left ${selected ? 'bg-[var(--color-selected)] rounded-control' : ''}`}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-control bg-ink/5 text-ink-fade"><FileVisual artifact={artifact} /></span>
        <span className="min-w-0 flex-1">
          <FileNameLabel value={filename} className={`w-full text-sm font-medium ${selected ? 'text-accent-ink' : 'text-ink'}`} />
          <span className="mt-0.5 block truncate text-xs uppercase tracking-wide text-ink-fade">{artifact.type || t('workbench.fileType')}</span>
          {artifact.path && <span className="mt-0.5 block truncate text-xs text-ink-fade" title={artifact.path}>{artifact.path}</span>}
          {snapshot && <span className="block text-xs text-ink-fade">{t('workbench.fileSnapshot')}</span>}
          {artifact.verificationPending && <span className="block text-xs text-ink-fade">{t('workbench.fileVerificationPending')}</span>}
        </span>
        <Eye className="h-3.5 w-3.5 text-ink-fade opacity-60 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </a>
      {!snapshot && <a href={withDownloadToken(artifact.url)} download={artifact.filename || ''}
        aria-label={t('chatPreview.download', { filename })} title={t('chatPreview.download', { filename })}
        className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade opacity-60 transition-opacity hover:bg-paper hover:text-accent-ink group-hover:opacity-100">
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </a>}
    </div>
  )
}

/**
 * The workspace's files, with the folder itself one press away.
 *
 * This pane used to be only the list of files the session produced, which is the
 * wrong list the moment a reader wants a file the session did not touch. It
 * wears the same shell as the change review now — the ≡ brings the folder over
 * the pane, and a file picked from it is read here — and keeps the session's own
 * outputs as what it shows before anything is picked, because that list carries
 * the download and preview links and nothing else does.
 */
export default function WorkbenchFiles({ artifacts, onOpenArtifact, t, workspacePath = '' }) {
  // "Currently selected" is local to this list: clicking a row marks it, so the
  // reader always sees which file the preview would act on.
  const [selectedKey, setSelectedKey] = useState(() => '')
  const [listOpen, setListOpen] = useState(false)
  const [openPath, setOpenPath] = useState('')
  const selectKey = (artifact) => String(artifact.id || artifact.url || artifact.filename || '')
  const groups = [
    { key: 'outputs', title: 'workbench.outputFiles', files: artifacts.filter((file) => !file.userAttachment) },
    { key: 'sources', title: 'workbench.sourceFiles', files: artifacts.filter((file) => file.userAttachment) },
  ]
  const openFolder = openPath ? openPath.replace(/[\\/][^\\/]*$/u, '') : workspacePath
  return (
    <section data-testid="workbench-files" data-artifact-surface="workbench-files" className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink/10 px-2">
        <button
          type="button"
          data-testid="workbench-files-toggle"
          aria-pressed={listOpen}
          aria-label={t(listOpen ? 'diffReview.hideFiles' : 'diffReview.showFiles')}
          title={t(listOpen ? 'diffReview.hideFiles' : 'diffReview.showFiles')}
          onClick={() => setListOpen((open) => !open)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <Menu className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        </button>
        {openPath
          ? <FileIdentity preview={{ path: openPath }} t={t} />
          : <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{t('workbench.workspaceFiles')}</span>}
      </div>
      {openPath ? (
        <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="workbench-file-content">
          <CurrentFileChange file={{ path: openPath }} t={t} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      {artifacts.length === 0 ? (
        <div className="flex h-44 items-center justify-center text-ink-fade"><Files className="h-7 w-7 opacity-30" aria-hidden="true" /></div>
      ) : groups.filter((group) => group.files.length > 0).map((group) => (
        <section key={group.key} data-testid={`workbench-${group.key}`} className="mb-4">
          <h3 className="mb-1 px-1 text-xs font-semibold text-ink">{t(group.title)}</h3>
          {group.files.map((artifact) => (
            <FileRow
              key={artifact.id}
              artifact={artifact}
              selected={selectKey(artifact) === selectedKey}
              onSelect={() => setSelectedKey(selectKey(artifact))}
              onOpenArtifact={onOpenArtifact}
              t={t}
            />
          ))}
        </section>
      ))}
        </div>
      )}
      {listOpen && (
        <FileListOverlay
          onClose={() => setListOpen(false)}
          onPick={(path) => { setOpenPath(path); setListOpen(false) }}
          rootPath={openFolder}
          t={t}
        />
      )}
    </section>
  )
}
