import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  LayoutList,
  ChevronDown,
  Check,
  Circle,
  Pause,
  X,
  ArrowUpRight,
} from 'lucide-react'

export default function ChatTaskPanel({
  tasks,
  skillChain,
  onPauseTask,
  onStopTask,
  onNavigateDetail,
}) {
  const [tasksExpanded, setTasksExpanded] = useState(true)
  const hasTasks = tasks.length > 0
  const activeTask = tasks.find((t) => t.status === 'running') || tasks[0]

  return (
    <div className="w-[360px] bg-paper-2 p-5 flex flex-col gap-4 border-l border-dashed border-ink-fade/50 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
          LIVE TASKS · {tasks.length}
        </span>
        {hasTasks && (
          <button
            onClick={() => setTasksExpanded((v) => !v)}
            className="inline-flex items-center h-6 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors"
          >
            {tasksExpanded ? '折叠' : '展开'}
            <ChevronDown className={`w-3 h-3 ml-1 transition-transform ${tasksExpanded ? '' : '-rotate-90'}`} />
          </button>
        )}
      </div>

      {hasTasks && !tasksExpanded && (
        <div className="text-xs text-ink-soft py-2">
          {tasks.length} 个任务进行中（已折叠）
        </div>
      )}

      {hasTasks && tasksExpanded ? (
        <>
          {tasks.map((task, i) => (
            <div
              key={task.id ?? i}
              className={`p-3 border rounded-md flex flex-col gap-2 ${
                task.status === 'running'
                  ? 'border-ink/40 bg-paper'
                  : 'border-dashed border-ink-fade/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-5 h-5 rounded flex items-center justify-center text-xs ${
                      task.status === 'running'
                        ? 'bg-ember-soft text-ember'
                        : 'bg-ink-ghost/30 text-ink-fade'
                    }`}
                  >
                    {task.status === 'running' ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <Circle className="w-3 h-3" />
                    )}
                  </div>
                  <span className="text-[13px] text-ink">{task.name}</span>
                </div>
                <span
                  className={`font-mono text-[9px] tracking-wider ${
                    task.status === 'running' ? 'text-ember' : 'text-ink-fade'
                  }`}
                >
                  {task.status === 'running' ? '●' + task.progress + '%' : task.step}
                </span>
              </div>

              {task.status === 'running' && (
                <>
                  <div className="h-1.5 bg-ink-ghost/40 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-ember rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${task.progress}%` }}
                      transition={{ duration: 1.2, ease: 'easeOut' }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] tracking-wider text-ink-fade">
                      STEP · {task.step} –{task.stepLabel}
                    </span>
                    {task.perms?.map((p, pi) => (
                      <span key={pi} className="font-mono text-[9px] tracking-wider text-ink-fade">
                        ●已使用· {p}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}

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

          {/* Quick actions */}
          <div className="mt-auto pt-4 flex gap-2">
            {activeTask && (
              <>
                <button
                  onClick={() => onPauseTask(activeTask.id)}
                  className="h-8 px-3 border border-dashed border-ink-fade/60 rounded-md text-xs text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1"
                >
                  <Pause className="w-3.5 h-3.5" />
                  暂停
                </button>
                <button
                  onClick={() => onStopTask(activeTask.id)}
                  className="h-8 px-3 border border-ink/70 rounded-md text-xs text-ink hover:bg-paper-2 transition-colors flex items-center gap-1"
                >
                  <X className="w-3.5 h-3.5" />
                  中断
                </button>
              </>
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
