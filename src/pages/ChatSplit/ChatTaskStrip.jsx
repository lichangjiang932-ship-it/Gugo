import { ArrowUpRight, Loader2, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { TASK_STATUS } from '../../store/taskStatus.js'

export default function ChatTaskStrip({
  tasks,
  onAbortTask,
  onNavigateDetail,
}) {
  const activeTask = tasks.find((task) => task.status === TASK_STATUS.RUNNING)
  if (!activeTask) return null

  return (
    <div className="px-6 pt-4">
      <div className="rounded-md border border-ink/15 bg-paper-2/80 px-4 py-3 flex items-center gap-4">
        <div className="w-8 h-8 rounded-md bg-ember-soft text-ember flex items-center justify-center shrink-0">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade shrink-0">
              当前任务
            </span>
            <span className="text-sm text-ink truncate" title={activeTask.name}>
              {activeTask.name}
            </span>
            <span className="font-mono text-[10px] text-ember shrink-0">
              {activeTask.progress ?? 0}%
            </span>
          </div>

          <div className="mt-2 h-1.5 bg-ink-ghost/40 rounded-full overflow-hidden" role="progressbar" aria-valuenow={activeTask.progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <motion.div
              className="h-full bg-ember rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${activeTask.progress ?? 0}%` }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
            />
          </div>

          <div className="mt-1.5 text-[11px] text-ink-fade truncate">
            {activeTask.stepLabel || '任务执行中'}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onAbortTask}
            className="h-8 px-3 border border-ink/70 rounded-md text-xs text-ink hover:bg-paper transition-colors flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" />
            中断
          </button>
          <button
            type="button"
            onClick={onNavigateDetail}
            className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 transition-colors flex items-center gap-1"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            详情
          </button>
        </div>
      </div>
    </div>
  )
}
