import { useState } from 'react'
import { CheckCircle2, Circle, CircleDot, ChevronDown, ChevronUp, ListTodo, X } from 'lucide-react'

/**
 * Feature 8: Todo 追踪 UI
 *
 * 由 manage_todos 工具驱动 — 模型每次更新整组 todos 替换显示。
 * 渲染为聊天区顶部 sticky 卡片:
 *   - 折叠时只显当前 in_progress 项 + 进度数字
 *   - 展开时显示全部 + 状态图标
 *   - 划线动画 + 颜色区分状态
 */
export default function TodoTracker({ todos, onClear }) {
  const [expanded, setExpanded] = useState(true)
  if (!Array.isArray(todos) || todos.length === 0) return null
  const total = todos.length
  const done = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.find((t) => t.status === 'in_progress')
  const progress = total === 0 ? 0 : Math.round((done / total) * 100)
  const allDone = done === total

  return (
    <div className="px-6 pt-4">
      <div className="rounded-md border border-ink/15 bg-paper-2/80 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
            allDone ? 'bg-emerald-100 text-emerald-700' : 'bg-ember-soft text-ember'
          }`}>
            <ListTodo className="w-4 h-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade shrink-0">
                Todo
              </span>
              <span className="text-sm text-ink truncate">
                {allDone
                  ? `全部完成 (${done}/${total})`
                  : inProgress
                    ? inProgress.activeForm
                    : `${done}/${total} 已完成`}
              </span>
            </div>
            <div className="mt-1.5 h-1 bg-ink/10 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${allDone ? 'bg-emerald-500' : 'bg-ember'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="h-7 w-7 rounded-md hover:bg-paper transition-colors flex items-center justify-center text-ink-fade hover:text-ink"
              title={expanded ? '折叠' : '展开'}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {onClear && (
              <button
                type="button"
                onClick={onClear}
                className="h-7 w-7 rounded-md hover:bg-paper transition-colors flex items-center justify-center text-ink-fade hover:text-ink"
                title="清空 Todo"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* List */}
        {expanded && (
          <div className="border-t border-ink/10 px-4 py-2 space-y-1">
            {todos.map((t, i) => (
              <TodoRow key={i} todo={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TodoRow({ todo }) {
  const isDone = todo.status === 'completed'
  const isProg = todo.status === 'in_progress'
  return (
    <div className="flex items-start gap-2.5 py-1 group">
      <span className="shrink-0 mt-[2px]">
        {isDone ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
        ) : isProg ? (
          <CircleDot className="w-4 h-4 text-ember animate-pulse" />
        ) : (
          <Circle className="w-4 h-4 text-ink-fade" />
        )}
      </span>
      <span
        className={`text-sm leading-snug break-words ${
          isDone ? 'text-ink-fade line-through' : isProg ? 'text-ink font-medium' : 'text-ink-soft'
        }`}
      >
        {isProg ? todo.activeForm : todo.content}
      </span>
    </div>
  )
}
