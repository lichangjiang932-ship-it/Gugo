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
import {
  getVisibleModelErrorMessage,
  getVisibleTurnClarification,
  isPermanentFailedRetryRejectionFailure,
  isPreExecutionFailure,
} from '../../../../lib/chatFlowGuards.js'
import { ArtifactReferenceLinks } from '../ArtifactCards.jsx'
import ActivityStream from '../ActivityStream.jsx'
import TaskProgressTable from './TaskProgressTable.jsx'
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
  const hasStructuredOutcome = msg.meta?.failed === true
    || msg.meta?.interrupted === true
    || msg.meta?.cancelled === true
    || (msg.meta?.serverRecoveryBlocked === true
      && msg.meta?.serverConnectionState === 'blocked')
  const recoveryBlocked = msg.meta?.serverRecoveryBlocked === true
    && msg.meta?.serverConnectionState === 'blocked'
  const genericRecoveryBlocked = recoveryBlocked
    && !String(msg.meta?.serverRecoveryKind || '').trim()
  const hasStructuredFailure = hasStructuredOutcome
    && msg.meta?.serverFailure
    && typeof msg.meta.serverFailure === 'object'
  const authoredContent = hasStructuredOutcome && typeof msg.meta?.serverPartialText === 'string'
    ? msg.meta.serverPartialText
    : msg.content
  const timeline = stableTimelineSegments(stripChoices(authoredContent), msg.meta?.toolCalls)
  const presentation = assistantTimelinePresentation(timeline)
  const hasExecution = isCurrentStreamingMessage || presentation.execution.length > 0
  const hasReasoningSummary = Boolean(String(msg.meta?.reasoning || '').trim())
  const hasProcessSummary = hasExecution || hasReasoningSummary
  const preExecutionFailure = isPreExecutionFailure(msg)
  const { modelSetupFailure, runtimeRestartRequired } = failurePresentation(msg)
  const failedRetryRejection = hasStructuredFailure
    && isPermanentFailedRetryRejectionFailure(msg)
  const failedRetryRejectionDetail = failedRetryRejection
    ? getVisibleModelErrorMessage(msg, t)
    : ''
  // serverPartialText is authoritative model-authored output for structured
  // failed, interrupted, cancelled, and recovery-blocked turns.
  // Derive missing presentation copy at render time so reloads and language
  // changes never treat server-localized error prose as assistant output.
  const visibleAnswer = (presentation.answer
    ? (failedRetryRejectionDetail && !presentation.answer.includes(failedRetryRejectionDetail)
        ? `${presentation.answer}\n\n${failedRetryRejectionDetail}`
        : presentation.answer)
    : '')
    || (msg.meta?.paused === true
      ? getVisibleTurnClarification(msg.meta?.serverClarification, t)
      : '')
    || (msg.meta?.cancelled === true
      ? t('chat.serverTurn.cancelled')
      : (msg.meta?.failed === true || msg.meta?.interrupted === true || genericRecoveryBlocked) && hasStructuredFailure
        ? getVisibleModelErrorMessage(msg, t)
        : '')

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
            {isCurrentStreamingMessage && <TaskProgressTable progress={msg.meta?.progress} />}
          </ExecutionDisclosure>
        )}
        {runtimeRestartRequired ? (
          <RuntimeRecoveryCard msg={msg} t={t} />
        ) : modelSetupFailure ? (
          <ModelSetupFailureCard msg={msg} onManageModels={onManageModels} t={t} />
        ) : visibleAnswer && (
          <div className="chat-assistant-answer">
            <MarkdownRenderer
              artifactReferences={inlineFileReferences}
              streaming={isCurrentStreamingMessage}
              onLinkClick={openInlineArtifact}
            >
              {visibleAnswer}
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
