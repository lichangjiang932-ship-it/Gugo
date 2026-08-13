import { ChevronDown, Quote } from 'lucide-react'
import { DEFAULT_MODEL_CONTEXT_WINDOW, estimateClientContextUsage } from '../../lib/contextUsage.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import ContextUsagePanel from './chatMessages/ContextUsagePanel.jsx'
import MessageRow from './chatMessages/MessageRow.jsx'
import NewConversationWelcome from './chatMessages/NewConversationWelcome.jsx'
import PermissionRequestCard from './chatMessages/PermissionRequestCard.jsx'
import useChatMessageViewport from './chatMessages/useChatMessageViewport.js'

export default function ChatMessages({
  messages,
  state,
  workbenchMessage,
  showContextUsage = true,
  showContextPanel,
  setShowContextPanel,
  selectedModel,
  isGenerating = false,
  contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
  toolSpecs = [],
  systemPrompt = '',
  onPermAllow,
  onPermDeny,
  onNavigatePermissions,
  onAuthorizeDirectoryRequest,
  onOpenArtifact,
  onOpenInPreview,
  onExpandCompaction,
  onQuoteSelection,
  onPromptSelect,
}) {
  const { t, lang } = useT()
  const viewport = useChatMessageViewport({ messages, onQuoteSelection })
  const {
    hiddenCount,
    visibleMessages,
    quoteBubble,
    atBottom,
    bindContainer,
    loadEarlierMessages,
    scrollToBottom,
    quoteSelection,
  } = viewport
  const generatingMessageId = isGenerating
    ? [...messages].reverse().find((message) => message?.role === 'assistant')?.id
    : null
  const contextUsage = estimateClientContextUsage({ messages, tools: toolSpecs, systemPrompt, contextWindow })
  const resolvedContextWindow = contextUsage.contextWindow

  return (
    <div ref={bindContainer} className="chat-scroll-region relative flex-1 overflow-y-auto px-4 py-4 sm:px-7">
      <div className="chat-conversation-column mx-auto flex w-full max-w-[840px] flex-col gap-5">
        {workbenchMessage && (
          <div className="rounded-lg border border-ink/10 bg-paper-2/55 px-3 py-2 text-xs text-ink-soft">{workbenchMessage}</div>
        )}
        {showContextUsage && (
          <ContextUsagePanel
            contextUsage={contextUsage}
            contextWindow={resolvedContextWindow}
            messages={messages}
            selectedModel={selectedModel}
            showDetails={showContextPanel}
            setShowDetails={setShowContextPanel}
            t={t}
          />
        )}
        {messages.length > 0 ? (
          <>
            {hiddenCount > 0 && (
              <div className="flex flex-col items-center gap-1 py-1 text-[11px] text-ink-fade">
                <button type="button" onClick={loadEarlierMessages} className="rounded-full border border-ink-fade/40 bg-paper px-3 py-1.5 text-ink-soft transition-colors hover:border-ember/50 hover:text-ink">
                  {t('chatWindow.loadEarlier')}
                </button>
                <span>{t('chatWindow.olderHidden', { count: hiddenCount })}</span>
              </div>
            )}
            {visibleMessages.map((msg, index) => (
              <MessageRow
                key={msg.id ?? hiddenCount + index}
                msg={msg}
                rowKey={msg.id ?? hiddenCount + index}
                generatingMessageId={generatingMessageId}
                lang={lang}
                onAuthorizeDirectoryRequest={onAuthorizeDirectoryRequest}
                onExpandCompaction={onExpandCompaction}
                onOpenArtifact={onOpenArtifact}
                onOpenInPreview={onOpenInPreview}
                t={t}
              />
            ))}
            <PermissionRequestCard
              request={state.permRequest}
              onAllow={onPermAllow}
              onDeny={onPermDeny}
              onNavigate={onNavigatePermissions}
              t={t}
            />
          </>
        ) : <NewConversationWelcome onPromptSelect={onPromptSelect} />}
      </div>
      {!atBottom && messages.length > 0 && (
        <button onClick={scrollToBottom} className="absolute bottom-4 right-6 z-10 inline-flex h-8 items-center gap-1.5 rounded-full border border-ink-fade/60 bg-paper px-3 text-xs text-ink-soft shadow-sm transition-colors hover:border-ink-fade hover:text-ink" title={t('chatMessages.backToBottom')} aria-label={t('chatMessages.backToBottom')}>
          <ChevronDown className="h-3.5 w-3.5" />{t('chatMessages.backToBottom')}
        </button>
      )}
      {quoteBubble && (
        <button
          type="button"
          onMouseDown={(event) => { event.preventDefault(); quoteSelection() }}
          style={{ top: quoteBubble.top, left: quoteBubble.left, transform: 'translateX(-50%)' }}
          className="absolute z-20 inline-flex h-7 items-center gap-1 rounded-full bg-ink px-2.5 text-xs font-medium text-paper shadow-lg transition-colors hover:bg-ember"
          title={t('nav.quoteSelectionTitle')}
          aria-label={t('nav.quoteSelectionTitle')}
        >
          <Quote className="h-3 w-3" />{t('nav.quoteSelection')}
        </button>
      )}
    </div>
  )
}
