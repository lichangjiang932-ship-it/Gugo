import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CheckCircle2, LayoutList, MessageSquare, Pause, X } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useAppContext } from '../store/AppContext'

const circumference = 264

export default function TaskRunPanel() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const tasks = state.tasks
  const task = tasks.find((t) => t.status === 'running') || tasks[0]
  const taskSteps = task?.steps || []

  if (!task) {
    return (
      <div className="h-screen flex bg-paper overflow-hidden">
        <LeftRail />
        <main className="flex-1 flex flex-col items-center justify-center min-w-0">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center text-center gap-4"
          >
            <div className="w-14 h-14 rounded-full border border-dashed border-ink-fade/60 flex items-center justify-center">
              <LayoutList className="w-6 h-6 text-ink-fade" />
            </div>
            <div>
              <h1 className="font-hand text-[28px] text-ink">没有进行中的任务</h1>
              <p className="text-sm text-ink-soft mt-1.5">发送一条对话后，任务状态会显示在这里。</p>
            </div>
            <button
              onClick={() => navigate('/chat')}
              className="h-9 px-5 bg-ember text-paper rounded-md font-hand text-sm hover:bg-ember/90 transition-colors flex items-center gap-1.5 mt-2"
            >
              <MessageSquare className="w-4 h-4" />
              返回对话
            </button>
          </motion.div>
        </main>
        <aside className="w-[440px] bg-paper-2 p-5 flex flex-col gap-4 border-l border-dashed border-ink-fade/50 overflow-y-auto">
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
            <div className="w-10 h-10 rounded-full border border-dashed border-ink-fade/60 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-ink-fade" />
            </div>
            <p className="text-sm text-ink-soft">任务面板为空</p>
            <p className="text-xs text-ink-fade">当前没有可暂停或中断的本地任务。</p>
          </div>
        </aside>
      </div>
    )
  }

  const handlePause = () => {
    dispatch({
      type: 'UPDATE_TASK',
      payload: { id: task.id, updates: { status: task.status === 'paused' ? 'running' : 'paused' } },
    })
  }

  const handleInterrupt = () => {
    dispatch({ type: 'REMOVE_TASK', payload: task.id })
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <main className="flex-1 flex flex-col min-w-0">
        <div className="px-7 py-4 flex items-center justify-between">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">SESSION · 任务执行</span>
          <span className="inline-flex items-center h-7 px-3 rounded-full text-xs border border-ember-line text-ember bg-ember-soft">
            {task.status} · {task.progress ?? 0}%
          </span>
        </div>
        <div className="flex-1" />
        <div className="px-7 pb-5 pt-3 text-xs text-ink-fade border-t border-dashed border-ink-fade/40">
          任务详情只显示当前聊天触发的真实任务状态；继续对话请返回聊天页。
        </div>
      </main>

      <aside className="w-[440px] bg-paper-2 p-5 flex flex-col gap-4 border-l border-dashed border-ink-fade/50 overflow-y-auto">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">TASK · {task.name || '本地任务'}</span>
            <h2 className="font-hand text-lg text-ink mt-1 truncate">{task.name || '本地任务'}</h2>
            <p className="text-xs text-ink-soft mt-1">{task.stepLabel || task.detail || '等待下一步执行状态。'}</p>
          </div>
          <span className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft shrink-0">
            {task.status}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative w-[100px] h-[100px] shrink-0">
            <svg width="100" height="100" className="-rotate-90">
              <circle cx="50" cy="50" r="42" stroke="var(--color-ink-ghost)" strokeWidth="6" fill="none" opacity="0.4" />
              <motion.circle
                cx="50"
                cy="50"
                r="42"
                stroke="var(--color-ember)"
                strokeWidth="6"
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - (task.progress ?? 0) / 100)}
                strokeLinecap="round"
                initial={{ strokeDashoffset: circumference }}
                animate={{ strokeDashoffset: circumference * (1 - (task.progress ?? 0) / 100) }}
                transition={{ duration: 1.5, ease: 'easeOut' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-hand text-2xl text-ember">{task.progress ?? 0}%</span>
              <span className="font-mono text-[9px] tracking-wider text-ink-fade">进度</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-1.5">
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">当前步骤</span>
            <span className="text-sm text-ink">{task.stepLabel || '等待任务更新'}</span>
            {task.perms?.length > 0 && (
              <span className="font-mono text-[9px] tracking-wider text-ember">已用 {task.perms.join(' / ')}</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">STEPS · {taskSteps.length}</span>
          {taskSteps.length ? (
            taskSteps.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${s.status === 'done' ? 'bg-ink' : s.status === 'active' ? 'bg-ember' : 'bg-ink-ghost'}`} />
                <span className="text-xs text-ink-soft">{s.name}</span>
                <div className="flex-1" />
                {s.status === 'active' && <span className="font-mono text-[9px] tracking-wider text-ember">正在</span>}
                {s.time && <span className="font-mono text-[9px] tracking-wider text-ink-fade">{s.time}</span>}
              </div>
            ))
          ) : (
            <div className="p-3 border border-dashed border-ink-fade/40 rounded-md text-xs text-ink-fade">
              这个任务还没有写入步骤轨迹。
            </div>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex gap-2 pt-2">
          <button
            onClick={handlePause}
            className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-hand text-sm text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1.5"
          >
            <Pause className="w-4 h-4" />
            {task.status === 'paused' ? '继续' : '暂停'}
          </button>
          <button
            onClick={handleInterrupt}
            className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5"
          >
            <X className="w-4 h-4" />
            中断
          </button>
        </div>
      </aside>
    </div>
  )
}
