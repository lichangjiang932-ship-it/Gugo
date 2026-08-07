import { Mic, Paperclip, Pause, Send } from 'lucide-react'
import PermissionModeSwitcher from '../../../components/PermissionModeSwitcher.jsx'
import ModelPicker from '../ModelPicker.jsx'

export default function ComposerActions({
  approvalMode,
  fileInputRef,
  isGenerating,
  modelOptions,
  modelPickerOpen,
  onAbort,
  onApprovalModeChange,
  onCloseModelPicker,
  onFileChange,
  onManageModels,
  onModelChange,
  onOpenModelPicker,
  onSend,
  onVoiceClick,
  selectedModel,
  t,
  voiceLabel,
  voiceState,
}) {
  return (
    <div className="mt-2.5 flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <input
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.csv,.xml,.yml,.yaml,.log,.js,.jsx,.ts,.tsx,.css,.html,.xlsx,.xls,.xlsm,.ods,.docx,.doc,.pptx,.ppt,.pdf,.zip,.epub,.rtf"
          ref={fileInputRef}
          className="hidden"
          onChange={onFileChange}
        />
        <button onClick={() => fileInputRef.current?.click()} title={t('chatComposer.attachment')} aria-label={t('chatComposer.attachment')} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-ink-ghost hover:text-ink-soft">
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <PermissionModeSwitcher mode={approvalMode} onChange={onApprovalModeChange} disabled={isGenerating} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <ModelPicker open={modelPickerOpen} modelOptions={modelOptions} selectedModel={selectedModel} onOpen={onOpenModelPicker} onClose={onCloseModelPicker} onSelect={onModelChange} onManage={onManageModels} />
        <button
          type="button"
          onClick={onVoiceClick}
          disabled={voiceState === 'requesting'}
          aria-pressed={voiceState === 'listening'}
          aria-label={voiceLabel}
          title={voiceLabel}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-wait ${voiceState === 'listening' ? 'bg-ember-soft text-ember animate-pulse' : ['unsupported', 'denied', 'error'].includes(voiceState) ? 'text-ink-fade' : 'text-ink-fade hover:bg-ink-ghost hover:text-ink-soft'}`}
        >
          <Mic className="h-3.5 w-3.5" />
        </button>
        {isGenerating ? (
          <button onClick={onAbort} className="flex h-8 items-center gap-1 rounded-full bg-ember px-3 text-xs font-medium text-paper transition-colors hover:bg-ember/90">
            <Pause className="h-3.5 w-3.5" />{t('chatComposer.stop')}
          </button>
        ) : (
          <button onClick={onSend} title={t('chatComposer.send')} aria-label={t('chatComposer.send')} className="flex h-8 w-8 items-center justify-center rounded-full bg-ink transition-colors hover:bg-ink-soft">
            <Send className="h-3.5 w-3.5 text-paper" />
          </button>
        )}
      </div>
    </div>
  )
}
