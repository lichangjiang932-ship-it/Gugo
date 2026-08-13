import { motion } from 'framer-motion'
import { X } from 'lucide-react'

export default function ContextUsagePanel({
  contextUsage,
  contextWindow,
  messages,
  selectedModel,
  showDetails,
  setShowDetails,
  t,
}) {
  const estimatedTokens = contextUsage.estimatedTokens
  const percent = contextUsage.percent

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDetails((visible) => !visible)}
        aria-expanded={showDetails}
        className="chat-context-bar ml-auto w-full max-w-[360px] self-end rounded-lg border border-ink/10 bg-paper-2/45 px-2.5 py-1.5 text-left transition-colors hover:border-ember/45 hover:bg-paper-2/75"
        title={t('chat.contextUsage.openDetails')}
      >
        <div className="flex items-center gap-2.5 text-[10px]">
          <span className="shrink-0 font-mono uppercase tracking-[0.14em] text-ink-fade">{t('chat.contextUsage.compactLabel')}</span>
          <div className="h-1 min-w-14 flex-1 overflow-hidden rounded-full bg-ink-ghost/70">
            <div className={`h-full rounded-full ${percent >= 80 ? 'bg-red-500' : percent >= 60 ? 'bg-amber-500' : 'bg-ember'}`} style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 font-mono text-ink-soft">~{estimatedTokens.toLocaleString()} / {contextUsage.contextWindow.toLocaleString()} · {percent}%</span>
        </div>
      </button>
      {showDetails && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="ml-auto w-full max-w-[430px] rounded-lg border border-ink/10 bg-paper-2/65 p-3 text-xs text-ink-soft"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ember">{t('chatMessages.contextTitle')}</span>
            <button type="button" onClick={() => setShowDetails(false)} className="text-ink-fade hover:text-ink" title={t('chat.contextUsage.closeDetails')} aria-label={t('chat.contextUsage.closeDetails')}>
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div><span className="text-ink-fade">{t('chat.contextUsage.messages')}</span><div className="font-semibold text-base text-ink">{messages.length}</div></div>
            <div><span className="text-ink-fade">{t('chat.contextUsage.visibleCharacters')}</span><div className="font-semibold text-base text-ink">{contextUsage.visibleCharacters.toLocaleString()}</div></div>
            <div><span className="text-ink-fade">{t('chat.contextUsage.model')}</span><div className="font-semibold text-base text-ink">{selectedModel || t('chat.contextUsage.backendDefault')}</div></div>
          </div>
          <div className="mt-2 border-t border-dashed border-ember/30 pt-2 text-[11px]">
            <div className="mb-2">
              <div className="flex items-center justify-between text-ink-fade">
                <span>{t('chat.contextUsage.estimatedUsage')}</span>
                <span>{estimatedTokens.toLocaleString()} / {Number(contextWindow).toLocaleString()} tokens · {percent}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-ghost"><div className="h-full rounded-full bg-ember" style={{ width: `${percent}%` }} /></div>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ink-fade sm:grid-cols-4">
              <span>{t('chat.contextUsage.messagePayload')} ~{contextUsage.messageTokens.toLocaleString()}</span>
              <span>{t('chat.contextUsage.toolCalls')} ~{contextUsage.toolCallTokens.toLocaleString()}</span>
              <span>{t('chat.contextUsage.attachments')} ~{contextUsage.attachmentTokens.toLocaleString()}</span>
              <span>{t('chat.contextUsage.toolDefinitions')} ~{contextUsage.toolSpecTokens.toLocaleString()}</span>
            </div>
            <div className="mb-2 text-ink-fade">{t('chat.contextUsage.estimateNotice')}</div>
            <span className="text-ink-fade">{t('chatMessages.provider')}</span>
            <span className="text-ink">{t('chatMessages.backendConfigured')}</span>
            <span className="ml-3 text-ink-fade">{t('chatMessages.keyServerOnly')}</span>
          </div>
        </motion.div>
      )}
    </>
  )
}
