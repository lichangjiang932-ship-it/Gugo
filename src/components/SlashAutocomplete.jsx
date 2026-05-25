/**
 * SlashAutocomplete — Phase 2 S4
 *
 * 把斜杠菜单从 ChatComposer 里抽出来，独立组件好测试也好扩展。
 * 现在支持两种条目：
 *   - kind:'skill'           → 内置技能 / 用户安装技能
 *   - kind:'prompt-template' → type='prompt-template' 的 plugin
 *
 * 选中 skill 时回调 onPickSkill(skill)；选中 template 时回调 onPickPromptTemplate(tpl)。
 * 调用方负责真正的副作用（prefill input / fetch template content / etc）。
 */
import { motion } from 'framer-motion'
import { FileText } from 'lucide-react'
import { SKILL_ICONS } from '../lib/skillIcons.js'

export default function SlashAutocomplete({
  visible,
  items,
  selectedIndex,
  setSelectedIndex,
  onPickSkill,
  onPickPromptTemplate,
  onDismiss,
}) {
  if (!visible) return null
  if (!items || items.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[30vh] bg-black/20"
      onClick={onDismiss}
      data-testid="slash-autocomplete-overlay"
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
          选择技能 / 模板
        </div>
        {items.map((item, i) => {
          const isTpl = item.kind === 'prompt-template'
          const Icon = isTpl ? FileText : SKILL_ICONS[item.id]
          const selected = i === selectedIndex
          return (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              onClick={() => {
                if (isTpl) onPickPromptTemplate?.(item.raw)
                else onPickSkill?.(item.raw)
              }}
              onMouseEnter={() => setSelectedIndex?.(i)}
              className={
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ' +
                (selected ? 'bg-ember-soft' : 'hover:bg-paper-2')
              }
              data-kind={item.kind}
              data-id={item.id}
            >
              {Icon ? <Icon className="w-5 h-5 text-ink-fade" /> : null}
              <div className="flex-1 min-w-0">
                <div className={'text-sm font-medium ' + (selected ? 'text-ember' : 'text-ink')}>
                  {item.name}
                </div>
                <div className="text-xs text-ink-fade truncate">{item.desc}</div>
              </div>
              {isTpl ? (
                <span className="font-mono text-[9px] text-ink-fade bg-paper-2 px-1.5 py-0.5 rounded border border-ink-fade/40">
                  模板
                </span>
              ) : item.recommended ? (
                <span className="font-mono text-[9px] text-ember bg-ember-soft px-1.5 py-0.5 rounded">
                  推荐
                </span>
              ) : null}
            </button>
          )
        })}
      </motion.div>
    </motion.div>
  )
}
