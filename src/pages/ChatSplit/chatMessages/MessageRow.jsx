import CompactionPill from '../../../components/CompactionPill.jsx'
import { shouldCollapseArtifactPreview } from '../../../lib/artifactPreview.js'
import {
  artifactHasInlineReference,
  buildMessageArtifactPreview,
  buildServerArtifactReferences,
  resolveDeliveryArtifacts,
} from '../../../lib/artifactReferences.js'
import {
  buildRetainedLocalFileReferences,
  buildVerifiedLocalFileReferences,
  mergeArtifactReferences,
} from '../../../lib/localFileReferences.js'
import { splitUserSkillCommand } from './messageContent.js'
import { buildAttachmentPreviewArtifact } from '../../../lib/attachmentPreview.js'
import {
  artifactTypeForSkill,
  isModelPreExecutionFailure,
  isPreExecutionFailure,
} from '../../../lib/chatFlowGuards.js'
import { UiContributionSlot } from '../../../plugins/uiContributionRegistry.js'
import {
  isModelRequestOutcomeUnknownRecoveryKind,
  isSideEffectOutcomeUnknownRecoveryKind,
} from '../../../lib/turnClient/turnEventDispatch.js'
import AssistantAnswer from './messageRow/AssistantAnswer.jsx'
import CollapsedArtifactContent from './messageRow/CollapsedArtifactContent.jsx'
import { SideEffectRecoveryCard } from './messageRow/FailureCards.jsx'
import IncompleteTaskNotice from './messageRow/IncompleteTaskNotice.jsx'
import { AssistantMeta, UserMeta } from './messageRow/MetaActions.jsx'
import { InlineDirectoryRequestCard, UserBubble } from './messageRow/UserBubble.jsx'

export default function MessageRow({
  msg,
  rowKey,
  turnIndex,
  generatingMessageId,
  isLatestUserMessage = false,
  lang,
  onExpandCompaction,
  onAuthorizeDirectoryRequest,
  onOpenArtifact,
  onOpenInPreview,
  onManageModels,
  onEditMessage,
  onRetryModelFailure,
  t,
}) {
  const serverClarification = msg.meta?.serverClarification
  const isDirectoryRequest = (serverClarification?.request_type || serverClarification?.requestType) === 'directory'
  const directoryRequestKey = [
    msg.meta?.serverTurnId || '',
    msg.meta?.serverLastSequence ?? '',
    serverClarification?.timestamp ?? '',
    serverClarification?.suggested_path || serverClarification?.suggestedPath || '',
    serverClarification?.access_mode || serverClarification?.accessMode || '',
  ].join(':')
  const resolvedDeliveryArtifacts = resolveDeliveryArtifacts(msg.meta)
  const isCurrentStreamingMessage = msg.meta?.streaming === true
    || (msg.meta?.streaming == null && msg.id === generatingMessageId)
  const isMessageComplete = !isCurrentStreamingMessage
  const isSuspendedTurn = msg.meta?.interrupted === true || msg.meta?.paused === true
  const canPresentManagedDeliverables = isMessageComplete
    && msg.meta?.failed !== true
    && !isSuspendedTurn
  const canPresentLocalFiles = isMessageComplete
    || isSuspendedTurn
    || msg.meta?.failed === true
  const canPresentDeliverables = canPresentManagedDeliverables || canPresentLocalFiles
  const deliveryArtifacts = canPresentManagedDeliverables ? resolvedDeliveryArtifacts : []
  const artifactPreview = deliveryArtifacts.length > 0 ? buildMessageArtifactPreview(msg) : null
  const showArtifactPreview = !!artifactPreview && canPresentManagedDeliverables
  const serverArtifactReferences = canPresentManagedDeliverables
    ? buildServerArtifactReferences({
        artifacts: deliveryArtifacts,
        content: String(msg.meta?.artifactSource || msg.content || ''),
        messageId: msg.id,
        preview: artifactPreview,
      })
    : []
  const verifiedLocalFileReferences = canPresentLocalFiles
    ? buildVerifiedLocalFileReferences({
        toolCalls: msg.meta?.toolCalls,
        verifiedLocalFiles: msg.meta?.verifiedLocalFiles,
        messageId: msg.id,
        turnId: msg.meta?.serverTurnId,
      })
    : []
  const retainedLocalFileReferences = canPresentLocalFiles
    ? buildRetainedLocalFileReferences({
        toolCalls: msg.meta?.toolCalls,
        retainedLocalFiles: msg.meta?.retainedLocalFiles,
        messageId: msg.id,
        turnId: msg.meta?.serverTurnId,
      })
    : []
  const localFileReferences = [...verifiedLocalFileReferences, ...retainedLocalFileReferences]
  const expectsFileReceipt = Boolean(
    String(msg.meta?.artifactType || '').trim() || artifactTypeForSkill(msg.meta?.skillId),
  )
  const artifactReferences = mergeArtifactReferences({
    serverReferences: serverArtifactReferences,
    verifiedLocalFileReferences,
    retainedLocalFileReferences,
  })
  const hasInlineArtifactReference = artifactReferences.some((reference) => (
    artifactHasInlineReference(msg.content, reference, artifactReferences)
  ))
  const collapseArtifact = isMessageComplete
    && showArtifactPreview
    && !hasInlineArtifactReference
    && shouldCollapseArtifactPreview(artifactPreview, {
      content: msg.content,
      artifactSource: msg.meta?.artifactSource,
    })
  const userSkillCommand = msg.role === 'user' ? splitUserSkillCommand(msg.content) : null
  const openArtifact = onOpenArtifact || ((artifact) => {
    if (artifact?.preview) onOpenInPreview?.(msg, artifact.preview)
  })
  const showSideEffectRecoveryCard = msg.role === 'assistant'
    && msg.meta?.serverRecoveryBlocked === true
    && isSideEffectOutcomeUnknownRecoveryKind(msg.meta?.serverRecoveryKind)
    && msg.meta?.serverConnectionState === 'blocked'
  const showModelRequestRecoveryCard = msg.role === 'assistant'
    && msg.meta?.serverRecoveryBlocked === true
    && isModelRequestOutcomeUnknownRecoveryKind(msg.meta?.serverRecoveryKind)
    && msg.meta?.serverConnectionState === 'blocked'
  const isIncompleteTerminal = msg.meta?.failed === true
    || (msg.meta?.interrupted === true && msg.meta?.streaming !== true)
    || msg.meta?.serverConnectionState === 'blocked'
  const showIncompleteTaskNotice = msg.role === 'assistant'
    && isIncompleteTerminal
    && msg.meta?.serverConnectionState !== 'reconnecting'
    && (msg.meta?.serverConnectionState === 'blocked' || !isCurrentStreamingMessage)
    && (msg.meta?.serverConnectionState === 'blocked' || !isPreExecutionFailure(msg))

  return (
    <div
      key={rowKey}
      id={msg.id ? `message-${msg.id}` : undefined}
      data-chat-turn-index={msg.role === 'user' ? turnIndex : undefined}
      data-message-role={msg.role}
      className={`group/message flex w-full py-0.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
    >
      <div className={collapseArtifact
        ? 'w-full max-w-[780px]'
        : msg.role === 'assistant'
          ? 'chat-assistant-message w-full max-w-[780px] text-[15px] leading-[1.65]'
          : 'flex max-w-[min(620px,72%)] flex-col items-end'}>
        {msg.role === 'assistant' ? (
          collapseArtifact ? (
            <CollapsedArtifactContent
              artifactReferences={artifactReferences}
              artifactPreview={artifactPreview}
              deliveryArtifacts={deliveryArtifacts}
              msg={msg}
              onOpenArtifact={openArtifact}
              t={t}
              retainedLocalFileReferences={retainedLocalFileReferences}
              verifiedLocalFileReferences={verifiedLocalFileReferences}
            />
          ) : (
            <AssistantAnswer
              artifactPreview={artifactPreview}
              artifactReferences={artifactReferences}
              canPresentDeliverables={canPresentDeliverables}
              deliveryArtifacts={deliveryArtifacts}
              isCurrentStreamingMessage={isCurrentStreamingMessage}
              isMessageComplete={isMessageComplete}
              msg={msg}
              onManageModels={onManageModels}
              onOpenArtifact={openArtifact}
              showArtifactPreview={showArtifactPreview}
              t={t}
              retainedLocalFileReferences={retainedLocalFileReferences}
              verifiedLocalFileReferences={verifiedLocalFileReferences}
            />
          )
        ) : (
          <UserBubble
            attachments={msg.attachments}
            command={userSkillCommand}
            content={msg.content}
            onOpenAttachment={(attachment) => {
              const artifact = buildAttachmentPreviewArtifact(attachment, { messageId: msg.id })
              if (artifact) openArtifact(artifact)
            }}
            t={t}
          />
        )}
        {showSideEffectRecoveryCard || showModelRequestRecoveryCard ? (
          <SideEffectRecoveryCard modelRequest={showModelRequestRecoveryCard} msg={msg} t={t} />
        ) : null}
        {msg.role === 'assistant' && isDirectoryRequest && (
          <InlineDirectoryRequestCard
            key={directoryRequestKey}
            msg={msg}
            onAuthorize={onAuthorizeDirectoryRequest}
            t={t}
          />
        )}
        {msg.role === 'user' && (
          <UserMeta lang={lang} msg={msg} onEditMessage={isLatestUserMessage ? onEditMessage : null} t={t} />
        )}
        {msg.role === 'assistant' && (
          <AssistantMeta
            isCurrentStreamingMessage={isCurrentStreamingMessage}
            lang={lang}
            msg={msg}
            onRetryModelFailure={isModelPreExecutionFailure(msg) ? onRetryModelFailure : null}
            showArtifactPreview={showArtifactPreview}
            t={t}
          />
        )}
        {showIncompleteTaskNotice && (
          <IncompleteTaskNotice
            expectsFileReceipt={expectsFileReceipt}
            msg={msg}
            onOpenArtifact={openArtifact}
            retainedCount={retainedLocalFileReferences.length}
            retainedLocalFileReferences={retainedLocalFileReferences}
            t={t}
            verifiedCount={verifiedLocalFileReferences.length}
            verifiedLocalFileReferences={verifiedLocalFileReferences}
          />
        )}
        {msg.role === 'assistant' && (
          <UiContributionSlot
            slot="conversation-node"
            context={{ msg, isCurrentStreamingMessage, isMessageComplete, onOpenArtifact: openArtifact, t }}
          />
        )}
        {msg.role === 'assistant' && msg.meta?.type === 'context_summary' && (
          <div className="mt-3 border-t border-ink/10 pt-2 text-xs text-ink-fade">
            <CompactionPill count={msg.meta.compressedCount || 0} archiveId={msg.meta.archiveId || msg.meta.compactionArchiveId} onExpand={onExpandCompaction} />
          </div>
        )}
      </div>
    </div>
  )
}
