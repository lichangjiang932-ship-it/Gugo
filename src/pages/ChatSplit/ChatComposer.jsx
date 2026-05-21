import { useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Paperclip,
  Mic,
  FolderOpen,
  Send,
  Pause,
  X,
  FileText,
} from 'lucide-react'
import { SKILL_ICONS } from '../../lib/skillIcons.js'

const QUICK_SKILLS = [
  { label: '/ppt', command: '/ppt', active: true },
  { label: '/excel', command: '/excel', active: false },
  { label: '/doc', command: '/doc', active: false },
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
      {/* Slash menu overlay */}
      <AnimatePresence>
        {showSlashMenu && filteredSkills.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center pt-[30vh] bg-black/20"
            onClick={() => setShowSlashMenu(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="w-[480px] max-h-[360px] overflow-y-auto rounded-xl shadow-2xl border border-ink-fade/50 bg-paper p-2"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2 py-1.5 font-mono text-[9px] tracking-wider text-ink-fade uppercase">
                选择技能
              </div>
              {filteredSkills.map((skill, i) => (
                <button
                  key={skill.id}
                  onClick={() => {
                    setInput('/' + skill.id + ' ')
                    setShowSlashMenu(false)
                    setTimeout(() => textareaRef.current?.focus(), 0)
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ' +
                    (i === selectedIndex ? 'bg-ember-soft' : 'hover:bg-paper-2')
                  }
                >
                  {(() => {
                    const Icon = SKILL_ICONS[skill.id]
                    return Icon ? <Icon className="w-5 h-5 text-ink-fade" /> : null
                  })()}
                  <div className="flex-1 min-w-0">
                    <div className={'text-sm font-medium ' + (i === selectedIndex ? 'text-ember' : 'text-ink')}>
                      {skill.name}
                    </div>
                    <div className="text-xs text-ink-fade truncate">{skill.desc}</div>
                  </div>
                  {skill.recommended && (
                    <span className="font-mono text-[9px] text-ember bg-ember-soft px-1.5 py-0.5 rounded">推荐</span>
                  )}
                </button>
              ))}
            </motion.div>
          </motion.div>
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
                    <img src={item.dataUrl} alt={item.name} className="w-7 h-7 object-cover rounded border border-ink-fade/30" />
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
                return skills.some(
                  (s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
                )
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
    </div>
  )
}
