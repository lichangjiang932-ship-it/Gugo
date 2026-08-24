import MarkdownRenderer from '../../../../components/MarkdownRenderer.jsx'
import ChoicePicker from '../../../../components/ChoicePicker.jsx'
import { hasChoices, stripChoices } from '../../../../lib/choices.js'
import {
  artifactReferenceOpenPayload,
  findArtifactReferenceByHref,
  findArtifactReferenceByLocalPath,
  resolveDeliveryArtifacts,
} from '../../../../lib/artifactReferences.js'
import { localFileOpenPayload } from '../../../../lib/localFileReferences.js'
import { isPreExecutionFailure } from '../../../../lib/chatFlowGuards.js'
import { ArtifactReferenceLinks } from '../ArtifactCards.jsx'
import ActivityStream from '../ActivityStream.jsx'
import {
  ExecutionDisclosure,
  TimelineSegments,
} from './ExecutionTimeline.jsx'
import {
  ModelSetupFailureCard,
  RuntimeRecoveryCard,
} from './FailureCards.jsx'
import { failurePresentation } from './failurePresentation.js'
import { assistantTimelinePresentation, stableTimelineSegments } from './timelinePresentation.js'

export default function AssistantAnswer({
  artifactPreview,
  artifactReferences,
  canPresentDeliverables,
  deliveryArtifacts,
  isCurrentStreamingMessage,
  isMessageComplete,
  msg,
  onManageModels,
  onOpenArtifact,
  retainedLocalFileReferences,
  showArtifactPreview,
  t,
  verifiedLocalFileReferences,
}) {
  const inlineFileReferences = artifactReferences
  const openInlineArtifact = (href) => {
    const reference = findArtifactReferenceByHref(inlineFileReferences, href)
      || findArtifactReferenceByLocalPath(inlineFileReferences, href)
    if (!reference) return false
    onOpenArtifact?.(
      localFileOpenPayload(reference)
        || artifactReferenceOpenPayload(reference, msg.id),
    )
    return true
  }
  const openToolArtifact = (reference) => {
    const payload = artifactReferenceOpenPayload(reference, msg.id)
    if (!payload) return false
    onOpenArtifact?.(payload)
    return true
  }
  const timeline = stableTimelineSegments(stripChoices(msg.content), msg.meta?.toolCalls)
  const presentation = assistantTimelinePresentation(timeline)
  const hasExecution = isCurrentStreamingMessage || presentation.execution.length > 0
  const hasReasoningSummary = Boolean(String(msg.meta?.reasoning || '').trim())
  const hasProcessSummary = hasExecution || hasReasoningSummary
  const preExecutionFailure = isPreExecutionFailure(msg)
  const { modelSetupFailure, runtimeRestartRequired } = failurePresentation(msg)

  return (
    <>
      <div data-quotable="true">
        {!preExecutionFailure && hasProcessSummary && (
          <ExecutionDisclosure
            hasExecution={hasProcessSummary}
            msg={msg}
            running={isCurrentStreamingMessage}
            t={t}
          >
            <TimelineSegments
              artifacts={inlineFileReferences}
              onLinkClick={openInlineArtifact}
              onOpenArtifact={openToolArtifact}
              segments={presentation.execution}
              streaming={isCurrentStreamingMessage}
            />
            {(isCurrentStreamingMessage || hasReasoningSummary) && <ActivityStream msg={msg} />}
          </ExecutionDisclosure>
        )}
        {runtimeRestartRequired ? (
          <RuntimeRecoveryCard msg={msg} t={t} />
        ) : modelSetupFailure ? (
          <ModelSetupFailureCard msg={msg} onManageModels={onManageModels} t={t} />
        ) : presentation.answer && (
          <div className="chat-assistant-answer">
            <MarkdownRenderer
              artifactReferences={inlineFileReferences}
              streaming={isCurrentStreamingMessage}
              onLinkClick={openInlineArtifact}
            >
              {presentation.answer}
            </MarkdownRenderer>
          </div>
        )}
      </div>
      {hasChoices(msg.content) && isMessageComplete && (
        <ChoicePicker
          text={msg.content}
          onChoose={(id, title) => window.dispatchEvent(new CustomEvent('choice-selected', {
            detail: { messageId: msg.id, choiceId: id, choiceTitle: title },
          }))}
        />
      )}
      {canPresentDeliverables && (showArtifactPreview || resolveDeliveryArtifacts(msg.meta).length > 0 || verifiedLocalFileReferences.length > 0 || retainedLocalFileReferences.length > 0) && (
        <ArtifactReferenceLinks
          deliveryArtifacts={deliveryArtifacts}
          msg={msg}
          preview={artifactPreview}
          onOpen={onOpenArtifact}
          referenceContent={presentation.answer}
          retainedLocalFileReferences={retainedLocalFileReferences}
          verifiedLocalFileReferences={verifiedLocalFileReferences}
        />
      )}
    </>
  )
}
