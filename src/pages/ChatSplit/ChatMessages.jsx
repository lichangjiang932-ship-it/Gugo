import { ChevronDown, Quote } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import MessageRow from './chatMessages/MessageRow.jsx'
import ChatMiniTimeline from './chatMessages/ChatMiniTimeline.jsx'
import NewConversationWelcome from './chatMessages/NewConversationWelcome.jsx'
import useChatMessageViewport from './chatMessages/useChatMessageViewport.js'

export default function ChatMessages({
  messages,
  workbenchMessage,
  isGenerating = false,
  onEditMessage,
  onManageModels,
  onAuthorizeDirectoryRequest,
  onOpenArtifact,
  onOpenInPreview,
  onExpandCompaction,
  onQuoteSelection,
  onRetryModelFailure,
  onPromptSelect,
  routeHash = '',
}) {
  const { t, lang } = useT()
  const viewport = useChatMessageViewport({ messages, onQuoteSelection, routeHash })
  const {
    hiddenCount,
    visibleMessages,
    quoteBubble,
    atBottom,
    bindContainer,
    loadEarlierMessages,
    activeTurnIndex,
    scrollToTurn,
    scrollToBottom,
    quoteSelection,
  } = viewport
  const generatingMessageId = isGenerating
    ? [...messages].reverse().find((message) => message?.role === 'assistant')?.id
    : null
  const latestUserMessageId = [...messages].reverse().find((message) => message?.role === 'user')?.id

  return (
    <div className="chat-messages-shell relative min-h-0 flex-1">
      <div ref={bindContainer} className="chat-scroll-region relative h-full overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
        <div className="chat-conversation-column mx-auto flex w-full max-w-[780px] flex-col gap-0">
        {workbenchMessage && (
          <div className="rounded-card border border-ink/10 bg-paper-2/55 px-3 py-2 text-xs text-ink-soft">{workbenchMessage}</div>
        )}
        {messages.length > 0 ? (
          <>
            {hiddenCount > 0 && (
              <div className="flex flex-col items-center gap-1 py-1 text-xs text-ink-fade tabular-nums">
                <button type="button" onClick={loadEarlierMessages} className="chat-chrome-button rounded-pill border border-ink-fade/40 bg-paper px-3 py-1.5 text-ink-soft hover:border-accent/50 hover:text-ink">
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
                turnIndex={hiddenCount + index}
                generatingMessageId={generatingMessageId}
                lang={lang}
                isLatestUserMessage={msg.id === latestUserMessageId}
                onAuthorizeDirectoryRequest={onAuthorizeDirectoryRequest}
                onExpandCompaction={onExpandCompaction}
                onOpenArtifact={onOpenArtifact}
                onOpenInPreview={onOpenInPreview}
                onManageModels={onManageModels}
                onEditMessage={onEditMessage}
                onRetryModelFailure={onRetryModelFailure}
                t={t}
              />
            ))}
          </>
        ) : (
          <NewConversationWelcome
            onPromptSelect={onPromptSelect}
          />
        )}
        </div>
        {!atBottom && messages.length > 0 && (
          <button onClick={scrollToBottom} className="chat-chrome-button absolute bottom-4 right-6 z-10 inline-flex h-8 items-center gap-1.5 rounded-pill border border-ink-fade/45 bg-paper px-3 text-xs text-ink-soft hover:border-ink-fade hover:text-ink" title={t('chatMessages.backToBottom')} aria-label={t('chatMessages.backToBottom')}>
            <ChevronDown className="h-3.5 w-3.5" />{t('chatMessages.backToBottom')}
          </button>
        )}
        {quoteBubble && (
          <button
            type="button"
            onMouseDown={(event) => { event.preventDefault(); quoteSelection() }}
            style={{ top: quoteBubble.top, left: quoteBubble.left, transform: 'translateX(-50%)' }}
            className="chat-chrome-button absolute z-20 inline-flex h-7 items-center gap-1 rounded-pill bg-ink px-2.5 text-xs font-medium text-accent-contrast hover:bg-accent"
            title={t('nav.quoteSelectionTitle')}
            aria-label={t('nav.quoteSelectionTitle')}
          >
            <Quote className="h-3 w-3" />{t('nav.quoteSelection')}
          </button>
        )}
      </div>
      <ChatMiniTimeline
        activeTurnIndex={activeTurnIndex}
        messages={messages}
        onSelectTurn={scrollToTurn}
        t={t}
      />
    </div>
  )
}
