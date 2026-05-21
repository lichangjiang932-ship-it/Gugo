import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Settings, Sparkles, Palette, Type, Moon, Sun, Gauge, Zap, Pause,
  LogOut, CreditCard, User, ChevronRight, Monitor, Layout
} from 'lucide-react'
import ThemeWrapper from '../components/ThemeWrapper.jsx'
import { useAppContext } from '../store/AppContext.jsx'

function Section({ title, icon: Icon, children, delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
      className="mb-6"
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-ember" />
        <h3 className="text-xs font-semibold tracking-wider uppercase text-ink-soft">{title}</h3>
        <div className="flex-1 h-px bg-ink-fade/10" />
      </div>
      <div className="space-y-2">
        {children}
      </div>
    </motion.div>
  )
}

function SettingRow({ label, description, children, danger }) {
  return (
    <div className={`flex items-center justify-between p-4 rounded-xl border transition-all duration-200 ${
      danger
        ? 'border-red-400/20 bg-red-50/20 hover:border-red-400/40'
        : 'border-ink/8 bg-paper-2/30 hover:bg-paper-2/50'
    }`}>
      <div>
        <div className={`text-sm font-medium ${danger ? 'text-red-700' : 'text-ink'}`}>{label}</div>
        {description && <div className={`text-[11px] mt-0.5 ${danger ? 'text-red-500/70' : 'text-ink-fade'}`}>{description}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-all duration-300 ${
        checked ? 'bg-ember' : 'bg-ink-fade/30'
      }`}
    >
      <div
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-paper shadow-sm transition-transform duration-300 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 px-3 border border-ink-fade/20 rounded-lg bg-paper text-sm text-ink outline-none focus:border-ember/50 transition-all cursor-pointer"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}

export default function SettingsView() {
  const { state, dispatch } = useAppContext()
  const navigate = useNavigate()
  const isLoggedIn = state.user.name !== '本地工作台'

  const handleToggleAnimations = () => {
    const next = !state.uiConfig.animations
    document.documentElement.setAttribute('data-animations', next ? 'true' : 'false')
    dispatch({ type: 'UPDATE_UI_CONFIG', payload: { animations: next } })
  }

  const handleSetTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme)
    dispatch({ type: 'UPDATE_UI_CONFIG', payload: { theme } })
  }

  const handleSetDensity = (density) => {
    document.documentElement.setAttribute('data-density', density)
    dispatch({ type: 'UPDATE_UI_CONFIG', payload: { density } })
  }

  const handleSetAnimations = (val) => {
    document.documentElement.setAttribute('data-animations', val ? 'true' : 'false')
    dispatch({ type: 'UPDATE_UI_CONFIG', payload: { animations: val } })
  }

  const handleLogout = () => {
    if (confirm('确定要退出登录吗？本地会话不会被删除。')) {
      dispatch({ type: 'LOGOUT' })
    }
  }

  return (
    <ThemeWrapper headerName="设置" headerPath="/settings">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-[680px] mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <span className="section-label">SETTINGS</span>
            <h1 className="font-hand text-3xl text-ink mt-1">设置</h1>
            <p className="text-sm text-ink-fade mt-2">自定义你的工作台体验</p>
          </motion.div>

          {/* Account Section */}
          <Section title="账户" icon={User} delay={0}>
            <SettingRow
              label={isLoggedIn ? state.user.name : '本地工作台'}
              description={isLoggedIn ? state.user.email : '未登录 — 你的会话保存在浏览器本地存储中'}
            >
              {isLoggedIn ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-ember bg-ember-soft/40 px-2.5 py-1 rounded-full">{state.user.plan}</span>
                  <button
                    onClick={handleLogout}
                    className="h-8 px-3 border border-red-400/30 rounded-lg text-xs text-red-600 hover:bg-red-50/30 transition-colors flex items-center gap-1.5"
                  >
                    <LogOut className="w-3 h-3" />
                    退出
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => navigate('/chat')}
                  className="h-8 px-4 bg-ink text-paper rounded-lg text-xs hover:bg-ink-soft transition-colors"
                >
                  登录
                </button>
              )}
            </SettingRow>
          </Section>

          {/* Appearance Section */}
          <Section title="外观" icon={Palette} delay={0.06}>
            <SettingRow label="主题" description="选择亮色或暗色主题">
              <div className="flex gap-1 p-1 border border-ink-fade/20 rounded-xl bg-paper-2/40">
                {[
                  { value: 'light', icon: Sun, label: '亮色' },
                  { value: 'dark', icon: Moon, label: '暗色' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleSetTheme(opt.value)}
                    className={`flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs transition-all ${
                      state.uiConfig.theme === opt.value
                        ? 'bg-paper text-ink shadow-sm'
                        : 'text-ink-fade hover:text-ink'
                    }`}
                  >
                    <opt.icon className="w-3.5 h-3.5" />
                    {opt.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow label="字体" description="调整编辑器字体大小">
              <Select
                value={String(state.uiConfig.fontSize || 14)}
                onChange={(v) => dispatch({ type: 'UPDATE_UI_CONFIG', payload: { fontSize: Number(v) } })}
                options={[
                  { value: '12', label: '12px' },
                  { value: '14', label: '14px' },
                  { value: '16', label: '16px' },
                  { value: '18', label: '18px' },
                ]}
              />
            </SettingRow>

            <SettingRow label="间距" description="调整界面元素间距">
              <Select
                value={state.uiConfig.density || 'comfortable'}
                onChange={handleSetDensity}
                options={[
                  { value: 'compact', label: '紧凑' },
                  { value: 'comfortable', label: '舒适' },
                  { value: 'loose', label: '宽松' },
                ]}
              />
            </SettingRow>
          </Section>

          {/* Behavior Section */}
          <Section title="行为" icon={Gauge} delay={0.12}>
            <SettingRow label="动画效果" description="启用或禁用界面动画">
              <Toggle
                checked={state.uiConfig.animations !== false}
                onChange={handleToggleAnimations}
              />
            </SettingRow>

            <SettingRow label="提交按钮" description="启用或禁用发送按钮">
              <Toggle
                checked={state.uiConfig.showSubmitButton !== false}
                onChange={(val) => dispatch({ type: 'UPDATE_UI_CONFIG', payload: { showSubmitButton: val } })}
              />
            </SettingRow>

            <SettingRow label="自动上下文摘要" description="当会话消息超过 16 条时自动压缩较早的消息">
              <Toggle
                checked={state.autoContextSummary !== false}
                onChange={(val) => dispatch({ type: 'SET_AUTO_CONTEXT_SUMMARY', payload: val })}
              />
            </SettingRow>

            <SettingRow label="记住上次使用的模型" description="记住你在对话中最后选择的模型">
              <Toggle
                checked={state.rememberLastModel !== false}
                onChange={(val) => dispatch({ type: 'SET_REMEMBER_LAST_MODEL', payload: val })}
              />
            </SettingRow>

            <SettingRow label="流式输出" description="实时逐字显示 AI 回复">
              <Toggle
                checked={state.streamOutput !== false}
                onChange={(val) => dispatch({ type: 'SET_STREAM_OUTPUT', payload: val })}
              />
            </SettingRow>

            <SettingRow label="工具结果显示" description="在聊天中展示工具调用卡片">
              <Toggle
                checked={state.showToolResult !== false}
                onChange={(val) => dispatch({ type: 'SET_SHOW_TOOL_RESULT', payload: val })}
              />
            </SettingRow>
          </Section>

          {/* Data Section */}
          <Section title="数据管理" icon={CreditCard} delay={0.18}>
            <SettingRow
              label="清除所有会话"
              description="永久删除所有会话数据，此操作不可撤销"
              danger
            >
              <button
                onClick={() => {
                  if (confirm('确定要清除所有会话吗？此操作不可撤销。')) {
                    dispatch({ type: 'CLEAR_ALL' })
                    window.dispatchEvent(new CustomEvent('app:clear-all'))
                  }
                }}
                className="h-8 px-4 border border-red-400/40 rounded-lg text-xs text-red-600 hover:bg-red-50/30 transition-colors"
              >
                清除
              </button>
            </SettingRow>
          </Section>
        </div>
      </div>
    </ThemeWrapper>
  )
}
