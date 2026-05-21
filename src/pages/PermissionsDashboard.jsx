import { motion } from 'framer-motion'
import { Pause, Mic, Bell, ShieldCheck, ShieldAlert, Shield, Eye } from 'lucide-react'
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
      className={`w-11 h-6 rounded-full relative transition-all duration-300 ${
        on ? 'bg-ember' : 'bg-ink-fade/25'
      }`}
    >
      <motion.div
        className={`absolute top-[2px] w-[20px] h-[20px] rounded-full shadow-sm ${
          on ? 'bg-paper left-[22px]' : 'bg-paper left-[2px]'
        }`}
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  )
}

function StatusBadge({ enabled }) {
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[10px] font-medium bg-emerald-50/40 text-emerald-700 border border-emerald-400/25">
        <ShieldCheck className="w-3 h-3" />
        已开启
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[10px] font-medium bg-ink-fade/10 text-ink-fade border border-ink-fade/15">
      <ShieldAlert className="w-3 h-3" />
      已关闭
    </span>
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
        if (result !== 'granted') return
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

  const stats = [
    { label: '已开启', value: enabledCount, color: '#5B8B6B', icon: ShieldCheck },
    { label: '已关闭', value: totalCount - enabledCount, color: '#8A7B68', icon: ShieldAlert },
    { label: '总计', value: totalCount, color: '#2E8FA3', icon: Shield },
  ]

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 p-8 overflow-y-auto">
        <div className="max-w-[800px] mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-end justify-between mb-8"
          >
            <div>
              <span className="section-label">PERMISSIONS CENTER</span>
              <h1 className="font-hand text-3xl text-ink mt-1">权限中心</h1>
              <p className="text-sm text-ink-fade mt-2 max-w-[480px]">
                管理当前浏览器内的本地权限开关。尚未开放命令执行或文件写入工具。
              </p>
            </div>
            <button
              onClick={handlePauseAll}
              disabled={enabledCount === 0}
              className="h-9 px-4 border border-dashed border-ink-fade/40 rounded-xl font-hand text-sm text-ink-soft hover:border-ink-fade/70 transition-colors flex items-center gap-2 disabled:opacity-40"
            >
              <Pause className="w-4 h-4" />
              全部关闭
            </button>
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="grid grid-cols-3 gap-4 mb-8"
          >
            {stats.map((s) => (
              <div key={s.label} className="p-4 rounded-xl border border-ink-fade/15 bg-paper-2/30">
                <div className="flex items-center gap-1.5 text-[11px] text-ink-fade/70 font-medium">
                  <s.icon className="w-3.5 h-3.5" style={{ color: s.color }} />
                  {s.label}
                </div>
                <div className="font-display text-2xl mt-1.5" style={{ color: s.color }}>{s.value}</div>
              </div>
            ))}
          </motion.div>

          {/* Table */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.16 }}
            className="border border-ink-fade/15 rounded-2xl overflow-hidden bg-paper-2/20"
          >
            {/* Table Header */}
            <div className="px-5 py-3 border-b border-ink-fade/10 grid grid-cols-[44px_1.4fr_1fr_1fr_80px] gap-3 items-center bg-paper-2/40">
              <span />
              <span className="section-label">能力</span>
              <span className="section-label">范围</span>
              <span className="section-label">状态</span>
              <span className="section-label">开关</span>
            </div>

            {/* Rows */}
            {permList.map((p, i) => {
              const IconComp = iconMap[p.code] || Mic
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: p.enabled ? 1 : 0.6 }}
                  transition={{ delay: 0.2 + i * 0.04 }}
                  className={`px-5 py-3.5 grid grid-cols-[44px_1.4fr_1fr_1fr_80px] gap-3 items-center transition-colors duration-200 hover:bg-paper-2/30 ${
                    i < permList.length - 1 ? 'border-b border-ink-fade/8' : ''
                  }`}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center"
                    style={{ background: `${p.enabled ? '#5B8B6B' : '#8A7B68'}12`, border: `1px solid ${p.enabled ? '#5B8B6B' : '#8A7B68'}25` }}
                  >
                    <IconComp className="w-4 h-4" style={{ color: p.enabled ? '#5B8B6B' : '#8A7B68' }} />
                  </div>
                  <div className="flex flex-col leading-tight">
                    <span className="text-sm text-ink font-medium">{p.name}</span>
                    <span className="font-mono text-[9px] tracking-wider text-ink-fade/60 mt-0.5">{p.code}</span>
                  </div>
                  <span className="text-sm text-ink-soft">{p.scope}</span>
                  <StatusBadge enabled={p.enabled} />
                  <PermSwitch on={p.enabled} onToggle={() => togglePerm(p.id)} label={`${p.enabled ? '关闭' : '开启'}${p.name}`} />
                </motion.div>
              )
            })}
          </motion.div>
        </div>
      </div>
    </div>
  )
}
