import { artifactReferenceOpenPayload } from '../../../../lib/artifactReferences.js'
import { ArtifactReferenceLinks } from '../ArtifactCards.jsx'
import { ToolCallTrace } from '../ActivityTraces.jsx'
import { ExecutionDisclosure } from './ExecutionTimeline.jsx'

const ARTIFACT_TYPE_LABELS = Object.freeze({
  docx: 'Word',
  html: 'HTML',
  html_multi: 'HTML',
  json: 'JSON',
  markdown: 'Markdown',
  mermaid: 'Mermaid',
  pdf: 'PDF',
  pptx: 'PowerPoint',
  react: 'React',
  svg: 'SVG',
  text: 'Text',
  xlsx: 'Excel',
})

function artifactTypeLabel(reference) {
  const type = String(reference?.type || '').trim().toLowerCase()
  if (!type || type === 'file') return ''
  return ARTIFACT_TYPE_LABELS[type] || type.toUpperCase()
}

function collapsedArtifactSummary(artifactReferences, t) {
  const references = Array.isArray(artifactReferences) ? artifactReferences : []
  if (references.length === 0) return t('chatMessages.artifactReadyGeneric')
  if (references.length === 1) {
    const [reference] = references
    const type = artifactTypeLabel(reference)
    if (!type) return t('chatMessages.artifactReadySingleFile', { filename: reference.filename })
    return t('chatMessages.artifactReadySingle', {
      filename: reference.filename,
      type,
    })
  }
  return t('chatMessages.artifactReadyMultiple', {
    count: references.length,
    filenames: references.map((reference) => reference.filename).join(', '),
  })
}

export default function CollapsedArtifactContent({
  artifactPreview,
  artifactReferences,
  deliveryArtifacts,
  msg,
  onOpenArtifact,
  retainedLocalFileReferences,
  t,
  verifiedLocalFileReferences,
}) {
  const openToolArtifact = (reference) => {
    const payload = artifactReferenceOpenPayload(reference, msg.id)
    if (!payload) return false
    onOpenArtifact?.(payload)
    return true
  }
  return (
    <>
      <div className="chat-assistant-message text-[15px] leading-7" data-quotable="true">
        <ExecutionDisclosure
          hasExecution={Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0}
          msg={msg}
          running={false}
          t={t}
        >
          {Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0 && (
            <ToolCallTrace calls={msg.meta.toolCalls} artifacts={artifactReferences} onOpenArtifact={openToolArtifact} />
          )}
        </ExecutionDisclosure>
        <p data-testid="artifact-completion-summary">{collapsedArtifactSummary(artifactReferences, t)}</p>
      </div>
      <ArtifactReferenceLinks
        deliveryArtifacts={deliveryArtifacts}
        msg={msg}
        preview={artifactPreview}
        onOpen={onOpenArtifact}
        retainedLocalFileReferences={retainedLocalFileReferences}
        verifiedLocalFileReferences={verifiedLocalFileReferences}
      />
    </>
  )
}
