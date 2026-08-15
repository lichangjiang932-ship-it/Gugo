import { X } from 'lucide-react'

/**
 * 上下文用量明细面板。挂在输入框上方,点击用量圆环打开:
 *   - 上下文用量(总用量 / 窗口 / 剩余)
 *   - 系统提示词、工具(定义+调用)、对话消息 三大占用来源
 */
export default function ContextUsagePanel({
  contextUsage,
  contextWindow,
  messages,
  selectedModel,
  onClose,
  t,
}) {
  const estimatedTokens = contextUsage.estimatedTokens
  const percent = contextUsage.percent
  const windowTokens = Number(contextUsage.contextWindow || contextWindow)
  const remaining = Math.max(0, windowTokens - estimatedTokens)

  return (
    <div className="mx-auto w-full max-w-[872px] rounded-lg border border-ink/10 bg-paper p-3 text-xs text-ink-soft shadow-sm" data-testid="context-usage-panel">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ember">{t('chatMessages.contextTitle')}</span>
        <button type="button" onClick={onClose} className="text-ink-fade hover:text-ink" title={t('chat.contextUsage.closeDetails')} aria-label={t('chat.contextUsage.closeDetails')}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-ink-fade">{t('chat.contextUsage.estimatedUsage')}</span>
        <span className="font-mono text-ink">{estimatedTokens.toLocaleString()} / {windowTokens.toLocaleString()} tokens</span>
        <span className={`font-mono ${percent >= 80 ? 'text-red-500' : percent >= 60 ? 'text-amber-500' : 'text-emerald-600'}`}>{percent}%</span>
        <span className="text-ink-fade">{t('chat.contextUsage.remaining')} <span className="font-mono text-ink-soft">~{remaining.toLocaleString()}</span></span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-dashed border-ink-fade/40 pt-2 text-[11px] sm:grid-cols-3">
        <div className="flex items-center justify-between gap-2"><span className="text-ink-fade">{t('chat.contextUsage.systemPrompt')}</span><span className="font-mono">~{contextUsage.systemTokens.toLocaleString()}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-ink-fade">{t('chat.contextUsage.toolDefinitions')}</span><span className="font-mono">~{contextUsage.toolSpecTokens.toLocaleString()}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-ink-fade">{t('chat.contextUsage.toolCalls')}</span><span className="font-mono">~{contextUsage.toolCallTokens.toLocaleString()}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-ink-fade">{t('chat.contextUsage.messagePayload')}</span><span className="font-mono">~{contextUsage.messageTokens.toLocaleString()}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-ink-fade">{t('chat.contextUsage.attachments')}</span><span className="font-mono">~{contextUsage.attachmentTokens.toLocaleString()}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-ink-fade">{t('chat.contextUsage.messages')}</span><span className="font-mono">{messages.length}</span></div>
      </div>
      <div className="mt-2 text-[10px] text-ink-fade">{t('chat.contextUsage.estimateNotice')}</div>
      <div className="mt-1 text-[10px] text-ink-fade">{t('chat.contextUsage.model')}: {selectedModel || t('chat.contextUsage.backendDefault')}</div>
    </div>
  )
}
