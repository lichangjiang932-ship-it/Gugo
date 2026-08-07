import { useRef, useEffect, useState } from 'react'
import FullscreenMediaModal from '../../components/FullscreenMediaModal.jsx'
import { useT } from '../../i18n/I18nProvider.jsx'
import SlashCommandMenu from './SlashCommandMenu.jsx'
import ComposerActions from './chatComposer/ComposerActions.jsx'
import ComposerAttachments from './chatComposer/ComposerAttachments.jsx'
import {
  Paperclip,
} from 'lucide-react'
import { getClipboardImageFiles } from '../../lib/chatAttachmentFiles.js'
import { resolveSlashMenuKey } from '../../lib/slashMenuNavigation.js'

function splitLeadingSkillCommand(value, skillIds = []) {
  const raw = String(value || '')
  const match = raw.match(/^\/([a-z0-9_-]+)\s([\s\S]*)$/i)
  if (!match) return { command: '', body: raw }
  const known = new Set((Array.isArray(skillIds) ? skillIds : []).map((id) => String(id).toLowerCase()))
  if (!known.has(match[1].toLowerCase())) return { command: '', body: raw }
  return { command: `/${match[1]}`, body: match[2] }
}

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
  skillIds = [],
  slashCommands = [],
  onSlashCommandSelect,
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
  const composerSurfaceRef = useRef(null)
  const slashListRef = useRef(null)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)
  const skillCommand = splitLeadingSkillCommand(input, skillIds)
  const slashMatch = String(input || '').match(/^\/([^\s/]*)$/i)
  const slashMenuOpen = !!slashMatch && !slashMenuDismissed
  const safeSlashIndex = Math.min(slashSelectedIndex, Math.max(0, slashCommands.length - 1))

  useEffect(() => {
    if (!slashMenuOpen) return undefined
    const selected = slashListRef.current?.querySelector(`[data-slash-index="${safeSlashIndex}"]`)
    selected?.scrollIntoView?.({ block: 'nearest' })
    const dismissOnOutsidePointer = (event) => {
      if (!composerSurfaceRef.current?.contains(event.target)) setSlashMenuDismissed(true)
    }
    window.addEventListener('pointerdown', dismissOnOutsidePointer)
    return () => window.removeEventListener('pointerdown', dismissOnOutsidePointer)
  }, [safeSlashIndex, slashMenuOpen])
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
      <div ref={composerSurfaceRef} className="relative mx-auto w-full max-w-[840px]">
        {slashMenuOpen && (
          <SlashCommandMenu
            items={slashCommands}
            selectedIndex={safeSlashIndex}
            listRef={slashListRef}
            onHighlight={setSlashSelectedIndex}
            onSelect={(entry) => {
              setSlashMenuDismissed(true)
              onSlashCommandSelect?.(entry)
            }}
          />
        )}
        <div className="flex min-h-[104px] flex-col justify-between rounded-2xl border border-ink/15 bg-paper px-3.5 py-3 shadow-[0_8px_28px_rgb(var(--color-ink-rgb)/0.07)]">
          <ComposerAttachments attachments={attachments} onClear={() => setAttachments([])} onOpenImage={setFullscreenSrc} onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} t={t} />
          <div className="flex items-start gap-2 min-h-6">
            {skillCommand.command && (
              <span
                data-testid="active-skill-command"
                className="mt-0.5 inline-flex h-6 shrink-0 items-center rounded-md bg-ink px-2 font-mono text-xs font-medium text-paper shadow-sm"
              >
                {skillCommand.command}
              </span>
            )}
            <textarea
              ref={textareaRef}
              value={skillCommand.command ? skillCommand.body : input}
              onChange={(e) => {
              setSlashMenuDismissed(false)
              setSlashSelectedIndex(0)
              setInput(skillCommand.command ? `${skillCommand.command} ${e.target.value}` : e.target.value)

              // ★ #21: 自动撑高 textarea (1 ~ 8 行)
              const ta = e.target
              ta.style.height = 'auto'
              ta.style.height = Math.min(ta.scrollHeight, 24 * 8) + 'px'
              }}
              onKeyDown={(e) => {
                if (slashMenuOpen) {
                  const action = resolveSlashMenuKey(e.key, safeSlashIndex, slashCommands.length)
                  if (action.handled) {
                    e.preventDefault()
                    if (action.selectedIndex !== undefined) setSlashSelectedIndex(action.selectedIndex)
                    if (action.dismiss) setSlashMenuDismissed(true)
                    if (action.selectIndex !== undefined) onSlashCommandSelect?.(slashCommands[action.selectIndex])
                    return
                  }
                }
                if (skillCommand.command && !skillCommand.body && e.key === 'Backspace' && !e.nativeEvent?.isComposing) {
                  e.preventDefault()
                  setInput('')
                  return
                }
                handleKeyDown(e)
              }}
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
          <ComposerActions
            approvalMode={approvalMode}
            fileInputRef={fileInputRef}
            isGenerating={isGenerating}
            modelOptions={modelOptions}
            modelPickerOpen={modelPickerOpen}
            onAbort={onAbort}
            onApprovalModeChange={onApprovalModeChange}
            onCloseModelPicker={onCloseModelPicker}
            onFileChange={onFileChange}
            onManageModels={onManageModels}
            onModelChange={onModelChange}
            onOpenModelPicker={onOpenModelPicker}
            onSend={onSend}
            onVoiceClick={onVoiceClick}
            selectedModel={selectedModel}
            t={t}
            voiceLabel={voiceLabel}
            voiceState={voiceState}
          />
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
