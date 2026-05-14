import { motion } from 'framer-motion'
import { Pause, Mic, Bell } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useAppContext } from '../store/AppContext'

const iconMap = {
  MIC: Mic,
  PUSH: Bell,
}

function PermSwitch({ on, onToggle, label }) {
  return (
    <button
      onClick={onToggle}
      aria-label={label}
      className={`w-[38px] h-[22px] rounded-full border relative transition-all duration-200 ${
        on ? 'bg-ember border-ember' : 'bg-paper border-ink-fade'
      }`}
    >
      <motion.div
        className={`absolute top-[2px] w-4 h-4 rounded-full ${
          on ? 'bg-paper left-[18px]' : 'bg-ink-fade left-[2px]'
        }`}
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  )
}

export default function PermissionsDashboard() {
  const { state, dispatch } = useAppContext()
  const permList = state.permissions

  const togglePerm = async (id) => {
    if (id === 'notify') {
      const perm = permList.find((p) => p.id === 'notify')
      if (!perm?.enabled && 'Notification' in window) {
        const result = await Notification.requestPermission()
        if (result !== 'granted') {
          return
        }
      }
    }
    dispatch({ type: 'TOGGLE_PERM', payload: id })
  }

  const handlePauseAll = () => {
    permList.forEach((p) => {
      if (p.enabled) dispatch({ type: 'TOGGLE_PERM', payload: p.id })
    })
  }

  const enabledCount = permList.filter((p) => p.enabled).length
  const totalCount = permList.length
  const disabledCount = totalCount - enabledCount

  const stats = [
    { label: '已开启权限', value: `${enabledCount}/${totalCount}`, tone: 'ember' },
    { label: '已关闭权限', value: String(disabledCount), tone: '' },
    { label: '保存位置', value: 'localStorage', tone: 'cyan' },
    { label: '可用权限', value: '浏览器内', tone: '' },
  ]

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 p-8 overflow-y-auto">
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">PERMISSIONS</span>
            <h1 className="font-hand text-[28px] text-ink mt-1.5">权限中心</h1>
            <p className="font-hand text-base text-ink-soft mt-1">
              这里仅管理当前浏览器内的本地权限开关；尚未开放命令执行或文件写入工具。
            </p>
          </div>
          <button
            onClick={handlePauseAll}
            disabled={enabledCount === 0}
            className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-hand text-sm text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Pause className="w-4 h-4" />
            全部关闭
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-5">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className="p-3.5 border border-ink/30 rounded-md bg-paper"
            >
              <span className={`font-mono text-[9px] tracking-wider ${s.tone === 'ember' ? 'text-ember' : s.tone === 'cyan' ? 'text-cyan' : 'text-ink-fade'}`}>
                {s.label}
              </span>
              <div className="font-hand text-[26px] text-ink mt-1.5">{s.value}</div>
            </motion.div>
          ))}
        </div>

        <div className="border border-ink/30 rounded-md overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dashed border-ink-fade/50 grid grid-cols-[40px_1.4fr_1fr_1fr_80px] gap-3 items-center bg-paper-2">
            <span />
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">能力</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">范围</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">状态</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">开关</span>
          </div>
          {permList.map((p, i) => {
            const IconComp = iconMap[p.code] || Mic
            return (
              <motion.div
                key={p.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: p.enabled ? 1 : 0.55 }}
                className={`px-4 py-3 grid grid-cols-[40px_1.4fr_1fr_1fr_80px] gap-3 items-center ${
                  i < permList.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''
                }`}
              >
                <div className="w-7 h-7 rounded-md border border-ink-fade/60 flex items-center justify-center bg-paper">
                  <IconComp className="w-3.5 h-3.5 text-ink-soft" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-sm text-ink">{p.name}</span>
                  <span className="font-mono text-[9px] tracking-wider text-ink-fade">{p.code}</span>
                </div>
                <span className="text-sm text-ink-soft">{p.scope}</span>
                <span className="text-sm text-ink-soft">{p.enabled ? '已开启' : '已关闭'}</span>
                <PermSwitch on={p.enabled} onToggle={() => togglePerm(p.id)} label={`${p.enabled ? '关闭' : '开启'}${p.name}`} />
              </motion.div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
