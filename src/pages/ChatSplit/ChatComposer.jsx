import { useRef, useEffect, useState, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import FullscreenMediaModal from '../../components/FullscreenMediaModal.jsx'
import SlashAutocomplete from '../../components/SlashAutocomplete.jsx'
import { buildSlashItems } from '../../components/slashItems.js'
import {
  Paperclip,
  Mic,
  FolderOpen,
  Send,
  Pause,
  X,
  FileText,
} from 'lucide-react'

const QUICK_SKILLS = [
  { label: '/ppt', command: '/ppt', active: true },
  { label: '/code', command: '/code', active: true },
  { label: '/review', command: '/review', active: true },
  { label: '/doc', command: '/doc', active: true },
  { label: '+ 全部技能', command: null, solid: true },
]

export default function ChatComposer({
  input,
  setInput,
  onSend,
  attachments,
  setAttachments,
  showSlashMenu,
  setShowSlashMenu,
  filteredSkills,
  selectedIndex,
  setSelectedIndex,
  voiceState,
  showContextPanel,
  isGenerating,
  onAbort,
  messages,
  onFileChange,
  onVoiceClick,
  onContextClick,
  onQuickSkillClick,
  handleKeyDown,
  skills,
  promptTemplates = [],
  onPickPromptTemplate,
}) {
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

  // Phase 2 S4: 把当前 slash query 跟 prompt-templates 合并到统一 items 数组
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1) : ''
  const slashItems = useMemo(
    () => buildSlashItems({ skills: filteredSkills, promptTemplates, query: slashQuery }),
    [filteredSkills, promptTemplates, slashQuery],
  )

  return (
    <div
      className="px-6 pb-6 pt-3 border-t border-dashed border-ink-fade/50 relative"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (!e.dataTransfer?.files?.length) return
        onFileChange?.({ target: { files: e.dataTransfer.files, value: '' } })
      }}
    >
      {/* Slash menu overlay (Phase 2 S4: SlashAutocomplete 抽离) */}
      <AnimatePresence>
        {showSlashMenu && slashItems.length > 0 && (
          <SlashAutocomplete
            visible
            items={slashItems}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            onPickSkill={(skill) => {
              setInput('/' + skill.id + ' ')
              setShowSlashMenu(false)
              setTimeout(() => textareaRef.current?.focus(), 0)
            }}
            onPickPromptTemplate={(tpl) => {
              setShowSlashMenu(false)
              onPickPromptTemplate?.(tpl)
              setTimeout(() => textareaRef.current?.focus(), 0)
            }}
            onDismiss={() => setShowSlashMenu(false)}
          />
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-2.5">
        {/* Quick skills */}
        <div className="flex gap-1.5 flex-wrap">
          {QUICK_SKILLS.map((s, i) => {
            const isActive = s.command && input.startsWith(s.command + ' ')
            return (
              <button
                key={i}
                onClick={() => onQuickSkillClick(s)}
                className={
                  'inline-flex items-center h-[22px] px-2.5 rounded-full text-xs border transition-colors ' +
                  (s.solid
                    ? 'bg-ink text-paper border-ink'
                    : isActive
                    ? 'border-ember-line text-ember bg-ember-soft'
                    : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade')
                }
              >
                {s.label}
              </button>
            )
          })}
        </div>

        <div className="border border-ink/70 rounded-md bg-paper flex flex-col justify-between min-h-[80px] p-3.5">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {attachments.map((item) => (
                <div key={item.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-ink-fade/40 bg-paper-2 text-xs text-ink-soft max-w-[240px]">
                  {item.kind === 'image' && item.dataUrl ? (
                    <img
                      src={item.dataUrl}
                      alt={item.name}
                      className="w-7 h-7 object-cover rounded border border-ink-fade/30 cursor-zoom-in"
                      onClick={() => setFullscreenSrc({ src: item.dataUrl, alt: item.name })}
                      title="点击查看大图"
                    />
                  ) : (
                    <FileText className="w-4 h-4 text-ink-fade shrink-0" />
                  )}
                  <span className="truncate">{item.name} · {item.sizeKB}KB</span>
                  {item.error && <span className="text-ember">!</span>}
                  <button
                    type="button"
                    onClick={() => setAttachments((current) => current.filter((a) => a.id !== item.id))}
                    className="text-ink-fade hover:text-ink"
                    title="移除附件"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setAttachments([])}
                className="px-2 py-1.5 rounded-md border border-dashed border-ink-fade/50 text-xs text-ink-fade hover:text-ink"
              >
                清空附件
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const val = e.target.value
              const prev = input
              setInput(val)

              // ★ #21: 自动撑高 textarea (1 ~ 8 行)
              const ta = e.target
              ta.style.height = 'auto'
              ta.style.height = Math.min(ta.scrollHeight, 24 * 8) + 'px'

              const shouldShow = (v) => {
                if (!v.startsWith('/') || v.includes(' ')) return false
                const q = v.slice(1).toLowerCase()
                if (!q) return true
                if (skills.some((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))) return true
                if (promptTemplates.some((p) => String(p.id || '').toLowerCase().includes(q) || String(p.name || '').toLowerCase().includes(q))) return true
                return false
              }

              const nowShow = shouldShow(val)
              const wasShow = shouldShow(prev)

              if (nowShow && !wasShow) {
                setShowSlashMenu(true)
                setSelectedIndex(0)
              } else if (!nowShow && wasShow) {
                setShowSlashMenu(false)
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入指令，或 / 调用技能…"
            className="w-full bg-transparent outline-none text-sm text-ink placeholder:text-ink-soft/80 resize-none flex-1 leading-6 max-h-48 overflow-y-auto"
            rows={1}
          />
          <div className="flex justify-between items-center mt-2">
            <div className="flex gap-1.5">
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
                className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors"
              >
                <Paperclip className="w-3.5 h-3.5 mr-1" />
                附件
              </button>
              <button
                onClick={onVoiceClick}
                className={
                  'inline-flex items-center h-7 px-2 rounded-full text-xs border transition-colors ' +
                  (voiceState === 'listening'
                    ? 'border-ember text-ember bg-ember-soft animate-pulse'
                    : voiceState === 'unsupported'
                    ? 'border-ink-fade/60 text-ink-fade'
                    : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade')
                }
              >
                <Mic className="w-3.5 h-3.5 mr-1" />
                {voiceState === 'listening' ? '聆听中' : voiceState === 'unsupported' ? '浏览器不支持' : '语音'}
              </button>
              <button
                onClick={onContextClick}
                className={
                  'inline-flex items-center h-7 px-2 rounded-full text-xs border transition-colors ' +
                  (showContextPanel
                    ? 'border-ember text-ember bg-ember-soft'
                    : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade')
                }
              >
                <FolderOpen className="w-3.5 h-3.5 mr-1" />
                上下文 · {messages.length}
              </button>
            </div>
            <div className="flex items-center gap-2.5">
              {isGenerating ? (
                <button
                  onClick={onAbort}
                  className="h-8 px-3 rounded-full bg-ember text-paper text-xs font-medium hover:bg-ember/90 transition-colors flex items-center gap-1"
                >
                  <Pause className="w-3.5 h-3.5" />
                  停止
                </button>
              ) : (
                <>
                  <span className="font-mono text-[9px] tracking-wider text-ink-fade">Enter</span>
                  <button
                    onClick={onSend}
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
