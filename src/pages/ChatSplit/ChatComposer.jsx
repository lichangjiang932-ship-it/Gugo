import { useRef, useEffect, useState } from 'react'
import FullscreenMediaModal from '../../components/FullscreenMediaModal.jsx'
import PermissionModeSwitcher from '../../components/PermissionModeSwitcher.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import ModelPicker from './ModelPicker.jsx'
import {
  Paperclip,
  Mic,
  Send,
  Pause,
  X,
  FileText,
} from 'lucide-react'
import { getClipboardImageFiles } from '../../lib/chatAttachmentFiles.js'

export default function ChatComposer({
  input,
  setInput,
  onSend,
  attachments,
  setAttachments,
  voiceState,
  modelPickerOpen,
  modelOptions,
  selectedModel,
  isGenerating,
  onAbort,
  onFileChange,
  onVoiceClick,
  onOpenModelPicker,
  onCloseModelPicker,
  onModelChange,
  onManageModels,
  approvalMode,
  onApprovalModeChange,
  handleKeyDown,
}) {
  const { t } = useT()
  const voiceLabel = {
    requesting: t('chatMessages.voiceRequesting'),
    listening: t('chatMessages.voiceListening'),
    unsupported: t('chatMessages.voiceUnsupported'),
    denied: t('chatMessages.voiceDenied'),
    error: t('chatMessages.voiceError'),
  }[voiceState] || t('chatMessages.voice')
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  // ★ #21: input 被外部清空 (发送后) 也回弹到 1 行高度
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    if (!input) {
      ta.style.height = 'auto'
    } else {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 24 * 8) + 'px'
    }
  }, [input])

  // Feature 9: 命令面板/外部触发的 prefill 事件
  useEffect(() => {
    const onPrefill = (e) => {
      const text = String(e.detail || '')
      if (!text) return
      setInput(text)
      // focus + 光标到末尾
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(text.length, text.length)
        }
      })
    }
    window.addEventListener('command-palette:prefill', onPrefill)
    return () => window.removeEventListener('command-palette:prefill', onPrefill)
  }, [setInput])

  const [fullscreenSrc, setFullscreenSrc] = useState(null)
  // 拖放上传：dragCounter 计数解决移到子元素时 dragleave 误触发导致高亮闪烁。
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const dragCounter = useRef(0)

  // 全局守卫：拖放文件到 composer 以外的任何区域时，浏览器默认会"打开/下载该文件"
  // 从而离开整个聊天页。这里在 window 级别 preventDefault，把误拖变成无害操作。
  // composer 自身的 onDrop 仍照常处理文件，不受影响。
  useEffect(() => {
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const onWindowDragOver = (e) => { if (hasFiles(e)) e.preventDefault() }
    const onWindowDrop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragCounter.current = 0
      setIsDraggingFile(false)
    }
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('drop', onWindowDrop)
    return () => {
      window.removeEventListener('dragover', onWindowDragOver)
      window.removeEventListener('drop', onWindowDrop)
    }
  }, [])

  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')

  return (
    <div
      className="chat-composer relative bg-paper/95 px-4 pb-4 pt-2 backdrop-blur-sm sm:px-6 sm:pb-5"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        dragCounter.current += 1
        setIsDraggingFile(true)
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return
        dragCounter.current = Math.max(0, dragCounter.current - 1)
        if (dragCounter.current === 0) setIsDraggingFile(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragCounter.current = 0
        setIsDraggingFile(false)
        if (!e.dataTransfer?.files?.length) return
        onFileChange?.({ target: { files: e.dataTransfer.files, value: '' } })
      }}
    >
      {isDraggingFile && (
        <div className="absolute inset-2 z-20 rounded-md border-2 border-dashed border-ember bg-ember-soft/80 flex items-center justify-center pointer-events-none">
          <span className="inline-flex items-center gap-2 text-sm text-ember font-medium">
            <Paperclip className="w-4 h-4" />
            {t('chatComposer.dropFiles')}
          </span>
        </div>
      )}
      <div className="mx-auto w-full max-w-[840px]">
        <div className="flex min-h-[104px] flex-col justify-between rounded-2xl border border-ink/15 bg-paper px-3.5 py-3 shadow-[0_8px_28px_rgb(var(--color-ink-rgb)/0.07)]">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {attachments.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded-md border border-ink-fade/40 bg-paper-2 text-xs text-ink-soft max-w-[280px]">
                  {item.kind === 'image' && item.dataUrl ? (
                    <img
                      src={item.dataUrl}
                      alt={item.name}
                      className="w-7 h-7 object-cover rounded border border-ink-fade/30 cursor-zoom-in"
                      onClick={() => setFullscreenSrc({ src: item.dataUrl, alt: item.name })}
                      title={t('chatComposer.viewImage')}
                    />
                  ) : (
                    <FileText className="w-4 h-4 text-ink-fade shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.name} · {item.sizeKB}KB</span>
                  {item.error && <span className="text-ember" title={item.error}>!</span>}
                  <button
                    type="button"
                    onClick={() => setAttachments((current) => current.filter((a) => a.id !== item.id))}
                    className="text-ink-fade hover:text-ink"
                    title={t('chatComposer.removeAttachment')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                  {item.error && <p className="w-full text-[10px] leading-4 text-rose-700">{item.error}</p>}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAttachments([])}
                className="px-2 py-1.5 rounded-md border border-dashed border-ink-fade/50 text-xs text-ink-fade hover:text-ink"
              >
                {t('chatComposer.clearAttachments')}
              </button>
            </div>
          )}
          <div className="flex items-start gap-2 min-h-6">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
              setInput(e.target.value)

              // ★ #21: 自动撑高 textarea (1 ~ 8 行)
              const ta = e.target
              ta.style.height = 'auto'
              ta.style.height = Math.min(ta.scrollHeight, 24 * 8) + 'px'
            }}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const images = getClipboardImageFiles(e.clipboardData)
                if (!images.length) return
                e.preventDefault()
                onFileChange?.({ target: { files: images, value: '' } })
              }}
            placeholder={t('chatComposer.placeholder')}
              className="w-full min-w-0 bg-transparent outline-none text-sm text-ink placeholder:text-ink-soft/80 resize-none flex-1 leading-6 max-h-48 overflow-y-auto"
              rows={1}
            />
          </div>
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
              <button
                onClick={() => fileInputRef.current?.click()}
                title={t('chatComposer.attachment')}
                aria-label={t('chatComposer.attachment')}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-ink-ghost hover:text-ink-soft"
              >
                <Paperclip className="w-3.5 h-3.5" />
              </button>
              <PermissionModeSwitcher
                mode={approvalMode}
                onChange={onApprovalModeChange}
                disabled={isGenerating}
              />
              <ModelPicker
                open={modelPickerOpen}
                modelOptions={modelOptions}
                selectedModel={selectedModel}
                onOpen={onOpenModelPicker}
                onClose={onCloseModelPicker}
                onSelect={onModelChange}
                onManage={onManageModels}
              />
              <button
                type="button"
                onClick={onVoiceClick}
                disabled={voiceState === 'requesting'}
                aria-pressed={voiceState === 'listening'}
                aria-label={voiceLabel}
                title={voiceLabel}
                className={
                  'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-wait ' +
                  (voiceState === 'listening'
                    ? 'bg-ember-soft text-ember animate-pulse'
                    : ['unsupported', 'denied', 'error'].includes(voiceState)
                    ? 'text-ink-fade'
                    : 'text-ink-fade hover:bg-ink-ghost hover:text-ink-soft')
                }
              >
                <Mic className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2.5">
              {isGenerating ? (
                <button
                  onClick={onAbort}
                  className="h-8 px-3 rounded-full bg-ember text-paper text-xs font-medium hover:bg-ember/90 transition-colors flex items-center gap-1"
                >
                  <Pause className="w-3.5 h-3.5" />
                  {t('chatComposer.stop')}
                </button>
              ) : (
                <>
                  <span className="hidden font-mono text-[9px] tracking-wider text-ink-fade sm:block">Enter</span>
                  <button
                    onClick={onSend}
                    title={t('chatComposer.send')}
                    aria-label={t('chatComposer.send')}
                    className="w-8 h-8 rounded-full bg-ink flex items-center justify-center hover:bg-ink-soft transition-colors"
                  >
                    <Send className="w-3.5 h-3.5 text-paper" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {fullscreenSrc && (
        <FullscreenMediaModal
          src={fullscreenSrc.src}
          alt={fullscreenSrc.alt}
          onClose={() => setFullscreenSrc(null)}
        />
      )}
    </div>
  )
}
