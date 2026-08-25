/**
 * ChoicePicker — 结构化选择器。
 *
 * 借鉴 Reasonix ask_choice 工具设计。
 * 当模型输出 [[choice:option1:summary|option2:summary]] 格式时渲染为可点击的选择卡片。
 *
 * 格式: [[choice:id1:title1~summary1|id2:title2~summary2]]
 *   - 每个选项由 id:title~summary 组成
 *   - 选项之间用 | 分隔
 *   - summary 可选
 */

import { useState } from 'react'
import { parseChoices } from '../lib/choices.js'

export default function ChoicePicker({ text, onChoose, disabled }) {
  const [selected, setSelected] = useState(null)
  const parsed = parseChoices(text)
  if (!parsed) return null

  const handleChoose = (option) => {
    if (disabled || selected) return
    setSelected(option.id)
    onChoose?.(option.id, option.title)
  }

  // 如果只有一个选项或某个明显正确 → 自动选择（类比 Reasonix "skip when one is clearly correct"）
  if (parsed.options.length === 1 && !disabled && !selected) {
    setTimeout(() => handleChoose(parsed.options[0]), 0)
    return null
  }

  return (
    <div className="mt-3 mb-2">
      <p className="text-xs text-ink-fade mb-2 font-medium tracking-wide">请选择一个选项：</p>
      <div className="flex flex-wrap gap-2">
        {parsed.options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => handleChoose(opt)}
            disabled={disabled || !!selected}
            className={`
              relative px-4 py-2.5 rounded-lg text-left text-sm border transition-all
              ${selected === opt.id
                ? 'bg-accent/10 border-accent text-ink shadow-sm'
                : selected
                  ? 'bg-paper-2 border-ink-fade/30 text-ink-fade cursor-not-allowed'
                  : 'bg-paper-2/60 border-ink-fade/30 text-ink hover:border-accent/50 hover:bg-accent-soft/5 hover:shadow-sm cursor-pointer'
              }
            `}
          >
            <span className="font-medium block">{opt.title}</span>
            {opt.summary && (
              <span className="text-xs text-ink-fade mt-0.5 block leading-tight">{opt.summary}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
