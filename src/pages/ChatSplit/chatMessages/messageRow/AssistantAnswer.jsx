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
import {
  ExecutionDisclosure,
  TimelineSegments,
} from './ExecutionTimeline.jsx'
import {
  ModelSetupFailureCard,
  RuntimeRecoveryCard,
} from './FailureCards.jsx'
import { failurePresentation } from './failurePresentation.js'
import { incompleteCardExplainsStop } from './incompleteTaskPresentation.js'
import { assistantTimelinePresentation, stableTimelineSegments } from './timelinePresentation.js'
import { assistantPublicTimeline } from '../../../../lib/assistantPublicTimeline.js'
import { parseAgentReportSections } from '../../../../../shared/agentReportSections.js'
import { buildAgentRounds, toAgentRoundList } from '../../../../lib/agentRounds.js'
import AgentRoundList from './AgentRoundList.jsx'

export default function AssistantAnswer({
  artifactPreview,
  artifactReferences,
  canPresentDeliverables,
  deliveryArtifacts,
  isCurrentStreamingMessage,
  isMessageComplete,
  msg,
  workspacePath = '',
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
  // A report marker with an empty body is not an answer. Treating it as one
  // folded the steps away *and* left the top level blank, so the message said
  // nothing at all; an empty body counts as "no report" and the steps stand in.
  const hasReport = sections.hasMarkers && sections.reportFound && Boolean(sections.report.trim())
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
  // The process is presented as the loop it describes — one-line steps, each
  // opening onto its own body — with every real call inside the round that asked
  // for it, and calls the narrative never mentioned following at the end. Only a
  // message with neither a narrative nor a recorded call falls back to the plain
  // timeline — see lib/agentRounds.js.
  const recordedCalls = presentation.execution
    .filter((segment) => segment.kind === 'tools')
    .flatMap((segment) => (Array.isArray(segment.calls) ? segment.calls : []))
  const pairsNarrative = buildAgentRounds({ trajectory: sections.trajectory, toolCalls: recordedCalls })
  const rounds = pairsNarrative ? toAgentRoundList(pairsNarrative.steps, pairsNarrative.leftoverCalls) : null
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
        && !incompleteCardExplainsStop(msg.meta.serverFailure)
        ? getVisibleModelErrorMessage(msg, t)
        : '')
  // A completed turn that would otherwise render nothing at all — no answer text
  // and nothing folded away either. Saying so beats a message box that looks
  // like it lost the reply. When there *are* steps, they are shown instead and
  // this notice stays out of the way.
  const emptyAnswerNotice = !visibleAnswer && !hasExecution && isMessageComplete
    && !modelSetupFailure && !runtimeRestartRequired && !preExecutionFailure
    ? t('chat.serverTurn.emptyAnswer')
    : ''

  return (
    <>
      <div data-message-body="true">
        {!preExecutionFailure && hasExecution && (
          <ExecutionDisclosure
            hasExecution={hasExecution}
            msg={msg}
            running={isCurrentStreamingMessage}
            preserveNarration={keepStepsOpen}
            t={t}
          >
            {rounds ? (
              // The loop: one line per step, each opening onto its own body, with
              // every real call inside the round that asked for it.
              <AgentRoundList
                artifacts={inlineFileReferences}
                onOpenArtifact={openToolArtifact}
                rounds={rounds}
                workspacePath={workspacePath}
                t={t}
              />
            ) : (
              <TimelineSegments
                artifacts={inlineFileReferences}
                onLinkClick={openInlineArtifact}
                onOpenArtifact={openToolArtifact}
                segments={presentation.execution}
                streaming={isCurrentStreamingMessage}
                workspacePath={workspacePath}
              />
            )}
            {isCurrentStreamingMessage && <ActivityStream msg={msg} />}
            {isCurrentStreamingMessage && <TaskProgressTable progress={msg.meta?.progress} />}
          </ExecutionDisclosure>
        )}
        {runtimeRestartRequired ? (
          <RuntimeRecoveryCard msg={msg} t={t} />
        ) : modelSetupFailure ? (
          <ModelSetupFailureCard msg={msg} onManageModels={onManageModels} t={t} />
        ) : visibleAnswer ? (
          <div className="chat-assistant-answer">
            <MarkdownRenderer
              artifactReferences={inlineFileReferences}
              streaming={isCurrentStreamingMessage}
              onLinkClick={openInlineArtifact}
            >
              {visibleAnswer}
            </MarkdownRenderer>
          </div>
        ) : emptyAnswerNotice && (
          <p className="chat-assistant-answer chat-answer-empty" data-testid="assistant-empty-answer">
            {emptyAnswerNotice}
          </p>
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
