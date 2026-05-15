import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  LayoutList,
  ChevronDown,
  Check,
  Circle,
  Loader2,
  AlertTriangle,
  Pause,
  X,
  ArrowUpRight,
} from 'lucide-react'
import { TASK_STATUS, TASK_STATUS_LABEL } from '../../store/taskStatus.js'

const STATUS_STYLES = {
  [TASK_STATUS.RUNNING]: {
    border: 'border-ink/40 bg-paper',
    badge: 'bg-ember-soft text-ember',
    text: 'text-ember',
    icon: Loader2,
    iconClass: 'w-3 h-3 animate-spin',
  },
  [TASK_STATUS.COMPLETED]: {
    border: 'border-dashed border-ink-fade/50',
    badge: 'bg-ember-soft text-ember',
    text: 'text-ink-soft',
    icon: Check,
    iconClass: 'w-3 h-3',
  },
  [TASK_STATUS.FAILED]: {
    border: 'border-red-400/60 bg-red-50/40',
    badge: 'bg-red-100 text-red-600',
    text: 'text-red-600',
    icon: AlertTriangle,
    iconClass: 'w-3 h-3',
  },
  [TASK_STATUS.CANCELLED]: {
    border: 'border-dashed border-ink-fade/40 opacity-70',
    badge: 'bg-ink-ghost/30 text-ink-fade',
    text: 'text-ink-fade',
    icon: X,
    iconClass: 'w-3 h-3',
  },
  [TASK_STATUS.PENDING]: {
    border: 'border-dashed border-ink-fade/50',
    badge: 'bg-ink-ghost/30 text-ink-fade',
    text: 'text-ink-fade',
    icon: Circle,
    iconClass: 'w-3 h-3',
  },
}

function getStyle(status) {
  return STATUS_STYLES[status] || STATUS_STYLES[TASK_STATUS.PENDING]
}

export default function ChatTaskPanel({
  tasks,
  skillChain,
  onPauseTask,
  onStopTask,
  onNavigateDetail,
}) {
  const [tasksExpanded, setTasksExpanded] = useState(true)
  const hasTasks = tasks.length > 0
  // 只挑真正 RUNNING 的当作"可暂停/可中断"对象;没有则不渲染按钮,
  // 防止误把已完成/已失败的任务当成 active 操作。
  const activeTask = tasks.find((t) => t.status === TASK_STATUS.RUNNING)
  const runningCount = tasks.filter((t) => t.status === TASK_STATUS.RUNNING).length

  return (
    <div className="w-[360px] bg-paper-2 p-5 flex flex-col gap-4 border-l border-dashed border-ink-fade/50 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
          LIVE TASKS · {runningCount}/{tasks.length}
        </span>
        {hasTasks && (
          <button
            onClick={() => setTasksExpanded((v) => !v)}
            className="inline-flex items-center h-6 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors"
            aria-expanded={tasksExpanded}
          >
            {tasksExpanded ? '折叠' : '展开'}
            <ChevronDown className={`w-3 h-3 ml-1 transition-transform ${tasksExpanded ? '' : '-rotate-90'}`} />
          </button>
        )}
      </div>

      {hasTasks && !tasksExpanded && (
        <div className="text-xs text-ink-soft py-2">
          {runningCount > 0 ? `${runningCount} 个任务进行中` : `${tasks.length} 个任务记录`}（已折叠）
        </div>
      )}

      {hasTasks && tasksExpanded ? (
        <>
          {tasks.map((task, i) => {
            const style = getStyle(task.status)
            const Icon = style.icon
            const isRunning = task.status === TASK_STATUS.RUNNING
            const label = TASK_STATUS_LABEL[task.status] || task.status
            return (
              <div
                key={task.id ?? i}
                className={`p-3 border rounded-md flex flex-col gap-2 ${style.border}`}
                data-status={task.status}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-5 h-5 rounded flex items-center justify-center ${style.badge}`}>
                      <Icon className={style.iconClass} />
                    </div>
                    <span className="text-[13px] text-ink truncate" title={task.name}>{task.name}</span>
                  </div>
                  <span className={`font-mono text-[9px] tracking-wider ${style.text}`}>
                    {isRunning ? `● ${task.progress}%` : label}
                  </span>
                </div>

                {isRunning && (
                  <>
                    <div
                      className="h-1.5 bg-ink-ghost/40 rounded-full overflow-hidden"
                      role="progressbar"
                      aria-valuenow={task.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <motion.div
                        className="h-full bg-ember rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${task.progress}%` }}
                        transition={{ duration: 0.6, ease: 'easeOut' }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] tracking-wider text-ink-fade">
                        STEP · {task.step} – {task.stepLabel}
                      </span>
                      {task.perms?.map((p, pi) => (
                        <span key={pi} className="font-mono text-[9px] tracking-wider text-ink-fade">
                          ● 已使用 · {p}
                        </span>
                      ))}
                    </div>
                  </>
                )}

                {task.status === TASK_STATUS.FAILED && task.stepLabel && (
                  <span className="text-[11px] text-red-600/90">{task.stepLabel}</span>
                )}
              </div>
            )
          })}

          {skillChain?.length > 0 && (
            <div className="border-t border-dashed border-ink-fade/50 pt-3">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
                SKILL CHAIN
              </span>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {skillChain.map((s, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center h-[22px] px-2.5 rounded-full text-xs border ${
                      i === skillChain.length - 1
                        ? 'border-ember-line text-ember bg-ember-soft'
                        : 'border-ink-fade/60 text-ink-soft'
                    }`}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Quick actions — 只在有 RUNNING 任务时渲染 暂停/中断 */}
          <div className="mt-auto pt-4 flex gap-2">
            {activeTask ? (
              <>
                <button
                  onClick={() => onPauseTask(activeTask.id)}
                  className="h-8 px-3 border border-dashed border-ink-fade/60 rounded-md text-xs text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1"
                  title={`暂停: ${activeTask.name}`}
                >
                  <Pause className="w-3.5 h-3.5" />
                  暂停
                </button>
                <button
                  onClick={() => onStopTask(activeTask.id)}
                  className="h-8 px-3 border border-ink/70 rounded-md text-xs text-ink hover:bg-paper-2 transition-colors flex items-center gap-1"
                  title={`中断: ${activeTask.name}`}
                >
                  <X className="w-3.5 h-3.5" />
                  中断
                </button>
              </>
            ) : (
              <span className="text-[11px] text-ink-fade self-center">无运行中任务</span>
            )}
            <button
              onClick={onNavigateDetail}
              className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 transition-colors flex items-center gap-1 ml-auto"
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
              详情
            </button>
          </div>
        </>
      ) : !hasTasks ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-10">
          <div className="w-10 h-10 rounded-full border border-dashed border-ink-fade/60 flex items-center justify-center">
            <LayoutList className="w-4 h-4 text-ink-fade" />
          </div>
          <div>
            <p className="text-sm text-ink-soft">暂无进行中的任务</p>
            <p className="text-xs text-ink-fade mt-1">
              发送消息即可开始新任务
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
