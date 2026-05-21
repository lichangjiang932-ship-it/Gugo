import { useRef, useEffect, useCallback } from 'react'
import {
  Send, Paperclip, Mic, MicOff, Loader2, BarChart3, FileText, Code2, Presentation, Image,
  ChevronDown, ChevronUp, X, FileCode, Table2, Database, LayoutList, Settings, Compass,
} from 'lucide-react'

const SKILL_ICONS = {
  ppt: Presentation, htmlppt: Image, excel: Table2, word: FileText, react: FileCode,
  context_summary: Database,
}

export default function ChatComposer({
  input,
  setInput,
  onSend,
  attachments = [],
  setAttachments,
  showSlashMenu,
  setShowSlashMenu,
  filteredSkills = [],
  selectedIndex,
  setSelectedIndex,
  voiceState,
  onVoiceClick,
  showContextPanel,
  onContextClick,
  isGenerating,
  onAbort,
  onFileChange,
  onQuickSkillClick,
  handleKeyDown,
  skills = [],
}) {
  const textareaRef = useRef(null)
  const isListening = voiceState === 'listening'
  const isPlaying = voiceState === 'playing'

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 256) + 'px'
  }, [input])

  const onTextareaKeyDown = useCallback(
    (e) => {
      if (showSlashMenu && filteredSkills.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => (i + 1) % filteredSkills.length); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length); return }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onQuickSkillClick?.(filteredSkills[selectedIndex]); setShowSlashMenu(false); return }
        if (e.key === 'Escape') { setShowSlashMenu(false); return }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); return }
      handleKeyDown?.(e)
    },
    [showSlashMenu, filteredSkills, selectedIndex, onSend, handleKeyDown, onQuickSkillClick, setSelectedIndex, setShowSlashMenu],
  )

  const removeAttachment = (index) => {
    const next = [...attachments]; next.splice(index, 1); setAttachments(next)
  }

  const activeSkillIds = skills.filter((s) => s.active).map((s) => s.id)

  return (
    <div className="shrink-0 border-t border-ink-fade/15 bg-paper z-10">
      <div className="px-5 py-2">
        {/* Skill pills */}
        <div className="flex flex-wrap items-center gap-1 mb-1.5">
          {skills.filter((s) => s.active).map((skill) => {
            const Icon = SKILL_ICONS[skill.id] || Code2
            return (
              <span key={skill.id} className="inline-flex items-center gap-1 h-[22px] px-2 rounded-full text-[10px] border border-ink-fade/20 bg-paper-2 text-ember">
                <Icon className="w-3 h-3" />
                {skill.name}
              </span>
            )
          })}
        </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {attachments.map((file, i) => (
              <div key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-paper-2 border border-ink-fade/15 text-[10px] text-ink-soft">
                <Paperclip className="w-2.5 h-2.5" />
                {file.name}
                <button onClick={() => removeAttachment(i)} className="ml-0.5 hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
              </div>
            ))}
          </div>
        )}

        {/* Input row */}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder="说点什么…"
            className="flex-1 bg-paper-2 border border-ink-fade/20 rounded-xl px-4 py-3 text-sm text-ink outline-none focus:border-ember/40 focus:ring-2 focus:ring-ember/10 transition-all resize-none max-h-[200px] placeholder:text-ink-fade/40"
          />
          <div className="flex items-center gap-1 shrink-0 pb-0.5">
            {/* File */}
            <label className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-fade hover:bg-paper-2 hover:text-ink cursor-pointer transition-colors" title="附件">
              <Paperclip className="w-[18px] h-[18px]" />
              <input type="file" multiple className="hidden" onChange={onFileChange} />
            </label>
            {/* Voice */}
            <button
              onClick={onVoiceClick}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${isListening ? 'bg-ember text-paper' : 'text-ink-fade hover:bg-paper-2 hover:text-ink'}`}
              title={isListening ? '停止语音' : '语音输入'}
            >
              {isListening ? <MicOff className="w-[18px] h-[18px]" /> : <Mic className="w-[18px] h-[18px]" />}
            </button>
            {/* Context */}
            <button
              onClick={onContextClick}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${showContextPanel ? 'bg-ember text-paper' : 'text-ink-fade hover:bg-paper-2 hover:text-ink'}`}
              title="上下文面板"
            >
              <LayoutList className="w-[18px] h-[18px]" />
            </button>
            {/* Send / Abort */}
            {isGenerating ? (
              <button
                onClick={onAbort}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                title="中止"
              >
                <Loader2 className="w-[18px] h-[18px] animate-spin" />
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!input.trim() && attachments.length === 0}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-ink text-paper hover:bg-ink-soft transition-colors disabled:opacity-30"
                title="发送"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
