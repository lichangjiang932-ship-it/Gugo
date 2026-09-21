import MarkdownRenderer from '../../../../components/MarkdownRenderer.jsx'
import ChoicePicker from '../../../../components/ChoicePicker.jsx'
import { hasChoices } from '../../../../lib/choices.js'
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
import TrajectoryEntries from './TrajectoryEntries.jsx'
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
import { assistantPublicTimeline } from '../../../../lib/assistantPublicTimeline.js'
import { parseAgentReportSections } from '../../../../../shared/agentReportSections.js'

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
    || msg.meta?.paused === true
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
  const publicView = assistantPublicTimeline(msg, authoredContent)
  const timeline = stableTimelineSegments(publicView.content, publicView.toolCalls)
  const presentation = assistantTimelinePresentation(timeline)
  // The model writes plain-text ReAct sections; the front end owns grouping and
  // markup. A message without markers (older turns, other flows) keeps the
  // previous rendering exactly: the report falls back to the whole answer.
  const sections = parseAgentReportSections(presentation.answer)
  const hasReport = sections.hasMarkers && sections.reportFound
  // Three cases, and each one is deliberate:
  //   markers + report  -> top level is the report, steps are folded.
  //   markers, no report -> the model wrote only steps, so the steps *are* the
  //     answer: keep them open instead of showing raw `【Thought】` as prose.
  //   no markers        -> unchanged legacy rendering (the whole answer).
  const reportText = hasReport
    ? sections.report
    : (sections.hasMarkers ? '' : presentation.answer)
  const hasTrajectory = sections.trajectory.length > 0
  const keepStepsOpen = sections.hasMarkers ? !hasReport : presentation.hasPublicNarration
  const hasExecution = isCurrentStreamingMessage || presentation.execution.length > 0 || hasTrajectory
  const preExecutionFailure = isPreExecutionFailure(msg)
  const { modelSetupFailure, runtimeRestartRequired } = failurePresentation(msg)
  const failedRetryRejection = hasStructuredFailure
    && isPermanentFailedRetryRejectionFailure(msg)
  const failedRetryRejectionDetail = failedRetryRejection
    ? getVisibleModelErrorMessage(msg, t)
    : ''
  // serverPartialText is authoritative model-authored output for structured
  // failed, interrupted, paused, cancelled, and recovery-blocked turns.
  // Derive missing presentation copy at render time so reloads and language
  // changes never treat server-localized error prose as assistant output.
  const visibleAnswer = (reportText
    ? (failedRetryRejectionDetail && !reportText.includes(failedRetryRejectionDetail)
        ? `${reportText}\n\n${failedRetryRejectionDetail}`
        : reportText)
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
        {!preExecutionFailure && hasExecution && (
          <ExecutionDisclosure
            hasExecution={hasExecution}
            msg={msg}
            running={isCurrentStreamingMessage}
            preserveNarration={keepStepsOpen}
            t={t}
          >
            <TimelineSegments
              artifacts={inlineFileReferences}
              onLinkClick={openInlineArtifact}
              onOpenArtifact={openToolArtifact}
              segments={presentation.execution}
              streaming={isCurrentStreamingMessage}
            />
            <TrajectoryEntries entries={sections.trajectory} t={t} />
            {isCurrentStreamingMessage && <ActivityStream msg={msg} />}
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
