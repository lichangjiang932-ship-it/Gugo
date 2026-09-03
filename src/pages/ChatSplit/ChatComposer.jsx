import { useRef, useEffect, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.jsx'
import SlashCommandMenu from './SlashCommandMenu.jsx'
import ComposerActions from './chatComposer/ComposerActions.jsx'
import ComposerAttachments from './chatComposer/ComposerAttachments.jsx'
import ComposerContextHeader from './chatComposer/ComposerContextHeader.jsx'
import {
  Paperclip,
} from 'lucide-react'
import { getClipboardFiles } from '../../lib/chatAttachmentFiles.js'
import { attachmentSendState } from '../../lib/chatAttachmentUpload.js'
import { buildAttachmentPreviewArtifact } from '../../lib/attachmentPreview.js'
import { resolveSlashMenuKey } from '../../lib/slashMenuNavigation.js'
import { splitLeadingSkillCommand } from './chatComposer/skillCommand.js'

const COMPOSER_INTERACTIVE_SELECTOR = 'button, input, textarea, select, option, a, label, [role="button"], [role="menuitem"], [role="option"], [contenteditable="true"]'

export default function ChatComposer({
  input,
  editingMessageId,
  setInput,
  onSend,
  attachments,
  setAttachments,
  contextPanelOpen,
  contextUsage,
  modelPickerOpen,
  modelOptions,
  modelReadiness,
  selectedModel,
  selectedModelProviderId,
  isGenerating,
  onAbort,
  onCancelMessageEdit,
  onFileChange,
  onToggleContext,
  onOpenModelPicker,
  onCloseModelPicker,
  onModelChange,
  onModelRetry,
  onManageModels,
  onOpenAttachment,
  approvalMode,
  onApprovalModeChange,
  handleKeyDown,
  skillIds = [],
  slashCommands = [],
  onSlashCommandSelect,
  onClearWorkspace,
  onSelectWorkspace,
  recentWorkspaces = [],
  selectedWorkspacePath = '',
  showWorkspacePicker = false,
  workspaceBusy = false,
  workspaceError = '',
}) {
  const { t } = useT()
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
  const attachmentState = attachmentSendState(attachments)

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
      className="chat-composer relative px-4 pb-3 pt-2 backdrop-blur-sm sm:px-6 sm:pb-4"
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
        <div className="absolute inset-2 z-20 rounded-card border-2 border-dashed border-accent bg-accent-soft/80 flex items-center justify-center pointer-events-none">
          <span className="inline-flex items-center gap-2 text-sm text-accent-ink font-medium">
            <Paperclip className="w-4 h-4" />
            {t('chatComposer.dropFiles')}
          </span>
        </div>
      )}
      <div ref={composerSurfaceRef} className="relative mx-auto w-full max-w-[780px]">
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
        <ComposerContextHeader
          editingMessageId={editingMessageId}
          onCancelMessageEdit={onCancelMessageEdit}
          onClearWorkspace={onClearWorkspace}
          onSelectWorkspace={onSelectWorkspace}
          recentWorkspaces={recentWorkspaces}
          selectedWorkspacePath={selectedWorkspacePath}
          showWorkspacePicker={showWorkspacePicker}
          t={t}
          workspaceBusy={workspaceBusy}
          workspaceError={workspaceError}
        />
        <div
          data-testid="chat-composer-surface"
          onClick={(event) => {
            if (event.defaultPrevented || event.target?.closest?.(COMPOSER_INTERACTIVE_SELECTOR)) return
            textareaRef.current?.focus()
          }}
          className="chat-composer-surface flex min-h-[108px] flex-col justify-between rounded-[22px] border bg-paper px-3.5 py-3"
        >
          <ComposerAttachments
            attachments={attachments}
            onClear={() => setAttachments([])}
            onOpen={(attachment) => {
              const artifact = buildAttachmentPreviewArtifact(attachment)
              if (artifact) onOpenAttachment?.(artifact)
            }}
            onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
            t={t}
          />
          <div className="flex min-h-6 cursor-text items-start gap-2">
            {skillCommand.command && (
              <span
                data-testid="active-skill-command"
                className="mt-0.5 inline-flex h-6 shrink-0 items-center rounded-control bg-ink/5 px-2 font-mono text-xs font-medium text-ink-soft"
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
                const files = getClipboardFiles(e.clipboardData)
                if (!files.length) return
                e.preventDefault()
                onFileChange?.({ target: { files, value: '' } })
              }}
              placeholder={t('chatComposer.placeholder')}
              aria-label={t('chatComposer.placeholder')}
              className="chat-composer-input w-full min-w-0 flex-1 cursor-text resize-none overflow-y-auto bg-transparent text-sm leading-6 text-ink outline-none placeholder:text-ink-soft max-h-48"
              rows={1}
            />
          </div>
          <ComposerActions
            approvalMode={approvalMode}
            contextPanelOpen={contextPanelOpen}
            contextUsage={contextUsage}
            hasDraftText={Boolean(String(input || '').trim())}
            fileInputRef={fileInputRef}
            isGenerating={isGenerating}
            modelOptions={modelOptions}
            modelReadiness={modelReadiness}
            modelPickerOpen={modelPickerOpen}
            onAbort={onAbort}
            onApprovalModeChange={onApprovalModeChange}
            onCloseModelPicker={onCloseModelPicker}
            onFileChange={onFileChange}
            onManageModels={onManageModels}
            onModelChange={onModelChange}
            onModelRetry={onModelRetry}
            onOpenModelPicker={onOpenModelPicker}
            onSend={onSend}
            onToggleContext={onToggleContext}
            sendDisabled={attachmentState.uploading || attachmentState.failed}
            selectedModel={selectedModel}
            selectedModelProviderId={selectedModelProviderId}
            t={t}
          />
        </div>
      </div>
    </div>
  )
}
