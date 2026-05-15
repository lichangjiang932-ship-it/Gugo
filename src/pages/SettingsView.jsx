import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  Download,
  FileJson,
  HardDrive,
  MessageSquare,
  Mic,
  Moon,
  RefreshCw,
  Server,
  Shield,
  Sun,
  Trash2,
  Upload,
  Zap,
  MonitorSmartphone,
} from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useAppContext } from '../store/AppContext'
import { clearPersistedState } from '../store/AppContext.jsx'
import { getAccount, getAuthToken, recharge, sendLoginCode, setAuthToken, verifyLoginCode } from '../lib/accountClient.js'
import {
  LOGIN_CODE_COUNTDOWN_SECONDS,
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../lib/loginCountdown.js'
import { getSystemDiagnostics, testModelEndpoint } from '../lib/modelClient.js'
import {
  wrapSessionsExport,
  wrapSettingsExport,
  parseImport,
  InvalidExportError,
  SCHEMA_VERSION,
} from '../store/exportSchema.js'

const SETTINGS_NAV = ['账户', '权限中心', '工具', '外观', '快捷键', '数据 & 导出']
const ACCENT_COLORS = ['#E86A3C', '#2E8FA3', '#A5C97A', '#D4A4FF']

const SHORTCUTS = [
  { category: '通用', items: [{ name: '新建对话', keys: ['Ctrl', 'N'] }, { name: '搜索技能', keys: ['Ctrl', 'K'] }, { name: '打开设置', keys: ['Ctrl', ','] }] },
  { category: '对话', items: [{ name: '发送消息', keys: ['Enter'] }, { name: '换行', keys: ['Shift', 'Enter'] }, { name: '清空当前会话', keys: ['Ctrl', 'L'] }] },
  { category: '导航', items: [{ name: '返回对话', keys: ['Esc'] }] },
]

const PERM_ICONS = {
  mic: Mic,
  notify: Bell,
}

function PermIcon({ id, className }) {
  const Icon = PERM_ICONS[id] || Shield
  return <Icon className={className} />
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getLocalStorageBytes() {
  if (typeof window === 'undefined') return 0
  let total = 0
  try {
    for (const key of Object.keys(window.localStorage)) {
      const value = window.localStorage.getItem(key) || ''
      total += key.length + value.length
    }
  } catch (err) {
    // SecurityError (Safari 隐私 / 跨源 iframe / quota 检测时也可能抛)
    console.warn('[SettingsView] localStorage 不可读:', err?.name || err)
    return 0
  }
  return total * 2
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function SettingsView() {
  const { state, dispatch } = useAppContext()
  const [activeNav, setActiveNav] = useState('账户')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [account, setAccount] = useState(null)
  const [accountMessage, setAccountMessage] = useState('')
  const [accountLoading, setAccountLoading] = useState(false)
  const [loginCodeCountdown, setLoginCodeCountdown] = useState(0)
  const [dataMessage, setDataMessage] = useState('')
  const [storageBytes, setStorageBytes] = useState(() => getLocalStorageBytes())
  const [diagnostics, setDiagnostics] = useState(null)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const importInputRef = useRef(null)

  const refreshStorage = () => setStorageBytes(getLocalStorageBytes())
  const refreshDiagnostics = async ({ check = false } = {}) => {
    setDiagnosticsLoading(true)
    setDiagnosticsMessage(check ? '正在探测模型端点...' : '')
    try {
      const data = await getSystemDiagnostics({ check })
      setDiagnostics(data)
      setDiagnosticsMessage(check ? '端点探测完成。' : '诊断状态已刷新。')
    } catch (err) {
      setDiagnosticsMessage(err.message)
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  useEffect(() => {
    if (getAuthToken()) {
      refreshAccount()
    }
    refreshDiagnostics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    refreshStorage()
  }, [state.sessions.length, state.history.length])

  useEffect(() => {
    if (loginCodeCountdown <= 0) return undefined
    const timer = window.setInterval(() => {
      setLoginCodeCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [loginCodeCountdown])

  const refreshAccount = async () => {
    setAccountLoading(true)
    try {
      const data = await getAccount()
      setAccount(data)
      dispatch({
        type: 'LOGIN',
        payload: {
          name: data.user.email.split('@')[0],
          email: data.user.email,
          avatar: '本',
          plan: `${data.user.credits} 积分`,
        },
      })
    } catch (err) {
      setAccount(null)
      setAccountMessage(err.message)
      if (/登录/.test(err.message)) setAuthToken('')
    } finally {
      setAccountLoading(false)
    }
  }

  const enabledPermCount = useMemo(
    () => state.permissions.filter((p) => p.enabled).length,
    [state.permissions]
  )

  function StatusPill({ ok, label }) {
    const tone =
      ok === true
        ? 'border-emerald-500/40 text-emerald-700 bg-emerald-50'
        : ok === false
        ? 'border-ember-line text-ember bg-ember-soft'
        : 'border-ink-fade/50 text-ink-soft bg-paper-2'
    return <span className={`inline-flex items-center h-7 px-2.5 rounded-full border text-xs ${tone}`}>{label}</span>
  }

  function renderDiagnostics() {
    const model = diagnostics?.model
    const endpoint = diagnostics?.endpoint
    const billing = diagnostics?.billing
    const mail = diagnostics?.mail

    const handleTestModel = async () => {
      setDiagnosticsLoading(true)
      setDiagnosticsMessage('正在发送测试消息...')
      try {
        const result = await testModelEndpoint()
        setDiagnosticsMessage(`测试成功，延迟 ${result.latency ?? 0} ms。`)
      } catch (err) {
        setDiagnosticsMessage(err.message)
      } finally {
        setDiagnosticsLoading(false)
      }
    }

    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">SYSTEM DIAGNOSTICS</span>
            <h1 className="font-hand text-[28px] text-ink mt-1.5">系统诊断</h1>
            <p className="text-sm text-ink-soft mt-1">读取后端 .env 的安全状态；API Key 和邮箱授权码不会返回浏览器。</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => refreshDiagnostics()} disabled={diagnosticsLoading} className="h-9 px-3 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5 disabled:opacity-50">
              <RefreshCw className="w-3.5 h-3.5" />
              刷新
            </button>
            <button onClick={() => refreshDiagnostics({ check: true })} disabled={diagnosticsLoading} className="h-9 px-3 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft transition-colors flex items-center gap-1.5 disabled:opacity-50">
              <Server className="w-3.5 h-3.5" />
              探测端点
            </button>
          </div>
        </div>

        <SettingsGroup title="模型服务">
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={model?.configured} label={model?.configured ? '已配置' : '未配置'} />
            <StatusPill ok={model?.apiKeyConfigured} label={model?.apiKeyConfigured ? 'API Key 已配置' : '缺少 API Key'} />
            <StatusPill ok={endpoint?.checked ? endpoint.ok : null} label={endpoint?.checked ? (endpoint.ok ? '端点可达' : '端点异常') : '未探测端点'} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Info label="Base URL" value={model?.baseUrlMasked || '未配置'} />
            <Info label="默认模型" value={model?.modelName || '未配置'} />
            <Info label="Temperature" value={String(model?.temperature ?? '未配置')} />
            <Info label="Max Tokens" value={String(model?.maxTokens ?? '未配置')} />
          </div>
          {model?.missing?.length ? <div className="p-3 border border-ember-line rounded-md bg-ember-soft text-sm text-ember">缺少环境变量：{model.missing.join(', ')}</div> : null}
          <button onClick={handleTestModel} disabled={diagnosticsLoading || !model?.configured} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 self-start">
            测试后端模型
          </button>
          {endpoint?.checked && !endpoint.ok ? <div className="p-3 border border-ember-line rounded-md bg-ember-soft text-sm text-ember">{endpoint.error || endpoint.reason}</div> : null}
          {endpoint?.remoteModels?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {endpoint.remoteModels.map((name) => <span key={name} className="px-2 py-1 rounded border border-ink-fade/40 text-xs text-ink-soft bg-paper">{name}</span>)}
            </div>
          ) : null}
        </SettingsGroup>

        <SettingsGroup title="模型列表与积分倍率">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(model?.models || []).map((item) => (
              <div key={item.name} className="p-3 border border-ink-fade/30 rounded-md flex items-center justify-between">
                <span className="text-sm text-ink">{item.name}</span>
                <span className="font-mono text-xs text-ember">x{item.multiplier}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Info label="每 1K Token 基准" value={`${billing?.basePer1k ?? '-'} 积分`} />
            <Info label="计费 Max Tokens" value={String(billing?.maxTokens ?? '-')} />
            <Info label="充值套餐" value={`${billing?.packages?.length ?? 0} 个`} />
          </div>
        </SettingsGroup>

        <SettingsGroup title="邮箱登录">
          <div className="flex flex-wrap gap-2">
            <StatusPill ok={mail?.configured} label={mail?.configured ? 'SMTP 已配置' : 'SMTP 未完整配置'} />
            <StatusPill ok={!mail?.devCodes} label={mail?.devCodes ? '会显示开发验证码' : '真实邮箱验证码'} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Info label="SMTP Server" value={mail?.server || '未配置'} />
            <Info label="SMTP Port" value={String(mail?.port ?? '未配置')} />
            <Info label="TLS/SSL" value={`TLS ${mail?.useTls ? '开' : '关'} / SSL ${mail?.useSsl ? '开' : '关'}`} />
            <Info label="Sender" value={mail?.sender || '未配置'} />
          </div>
          {mail?.missing?.length ? <div className="p-3 border border-ember-line rounded-md bg-ember-soft text-sm text-ember">缺少邮箱变量：{mail.missing.join(', ')}</div> : null}
        </SettingsGroup>

        {diagnosticsMessage && <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{diagnosticsMessage}</div>}
      </section>
    )
  }

  function renderAccount() {
    const handleSendCode = async (e) => {
      e.preventDefault()
      setAccountLoading(true)
      setAccountMessage('')
      try {
        const result = await sendLoginCode(loginEmail)
        setLoginCodeCountdown(LOGIN_CODE_COUNTDOWN_SECONDS)
        setAccountMessage(result.devCode ? `验证码已生成：${result.devCode}` : '验证码已发送，请检查邮箱。')
      } catch (err) {
        setAccountMessage(err.message)
      } finally {
        setAccountLoading(false)
      }
    }

    const handleVerify = async (e) => {
      e.preventDefault()
      setAccountLoading(true)
      setAccountMessage('')
      try {
        const data = await verifyLoginCode({ email: loginEmail, code: loginCode })
        setAccount(data)
        dispatch({
          type: 'LOGIN',
          payload: {
            name: data.user.email.split('@')[0],
            email: data.user.email,
            avatar: '本',
            plan: `${data.user.credits} 积分`,
          },
        })
        setAccountMessage('登录成功。')
      } catch (err) {
        setAccountMessage(err.message)
      } finally {
        setAccountLoading(false)
      }
    }

    const handleRecharge = async (packageId) => {
      setAccountLoading(true)
      setAccountMessage('')
      try {
        const data = await recharge(packageId)
        setAccount(data)
        dispatch({
          type: 'LOGIN',
          payload: {
            name: data.user.email.split('@')[0],
            email: data.user.email,
            avatar: '本',
            plan: `${data.user.credits} 积分`,
          },
        })
        setAccountMessage('充值成功，积分已到账。')
      } catch (err) {
        setAccountMessage(err.message)
      } finally {
        setAccountLoading(false)
      }
    }

    const handleLogout = () => {
      setAuthToken('')
      setAccount(null)
      dispatch({ type: 'LOGOUT' })
      setAccountMessage('已退出登录。')
    }

    const packages = account?.packages || [
      { id: 'local-10', amount: 10, credits: 1000, label: '10 元' },
      { id: 'local-50', amount: 50, credits: 5000, label: '50 元' },
      { id: 'local-100', amount: 100, credits: 11000, label: '100 元' },
      { id: 'local-300', amount: 300, credits: 36000, label: '300 元' },
    ]

    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">ACCOUNT & CREDITS</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">账户</h1>
          <p className="text-sm text-ink-soft mt-1">邮箱验证码登录，本地点击金额即可充值积分，不接真实支付。</p>
        </div>

        {account?.user ? (
          <>
            <div className="p-4 border border-ink/30 rounded-md flex items-center justify-between gap-4">
              <div>
                <div className="text-base text-ink">{account.user.email}</div>
                <div className="font-hand text-[34px] text-ember mt-1">{account.user.credits} 积分</div>
              </div>
              <button
                onClick={handleLogout}
                className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md text-sm text-ink-soft hover:border-ink-fade"
              >
                退出
              </button>
            </div>

            <SettingsGroup title="本地充值">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {packages.map((pack) => (
                  <button
                    key={pack.id}
                    onClick={() => handleRecharge(pack.id)}
                    disabled={accountLoading}
                    className="p-4 border border-ink/40 rounded-md hover:border-ember hover:bg-ember-soft/40 transition-colors disabled:opacity-50 text-left"
                  >
                    <div className="font-hand text-xl text-ink">{pack.label}</div>
                    <div className="text-sm text-ember mt-1">+{pack.credits} 积分</div>
                  </button>
                ))}
              </div>
            </SettingsGroup>

            <SettingsGroup title="最近账单">
              <div className="flex flex-col gap-2">
                {(account.ledger || []).length ? account.ledger.map((item) => (
                  <div key={item.id} className="flex items-center justify-between p-2 border border-ink-fade/30 rounded-md text-sm">
                    <span className="text-ink-soft">{item.type === 'recharge' ? '充值' : `模型调用 · ${item.modelName || ''}`}</span>
                    <span className={item.credits > 0 ? 'text-ember' : 'text-ink'}>{item.credits > 0 ? '+' : ''}{item.credits}</span>
                  </div>
                )) : <div className="text-sm text-ink-fade">暂无账单记录。</div>}
              </div>
            </SettingsGroup>
          </>
        ) : (
          <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3 max-w-xl">
            <form onSubmit={handleSendCode} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">邮箱</span>
                <input
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                />
              </label>
              <button
                disabled={shouldDisableLoginCodeButton({
                  accountLoading,
                  loginEmail,
                  countdown: loginCodeCountdown,
                })}
                className="h-9 px-4 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft transition-colors self-start disabled:opacity-50"
              >
                {formatLoginCodeCountdownLabel(loginCodeCountdown)}
              </button>
            </form>
            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">验证码</span>
                <input
                  value={loginCode}
                  onChange={(e) => setLoginCode(e.target.value)}
                  placeholder="6 位数字"
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                />
              </label>
              <button
                disabled={accountLoading || !loginEmail.trim() || !loginCode.trim()}
                className="h-9 px-4 bg-ember text-paper rounded-md text-sm hover:bg-ember/90 transition-colors self-start disabled:opacity-50"
              >
                登录
              </button>
            </form>
          </div>
        )}

        {accountMessage && <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{accountMessage}</div>}
      </section>
    )
  }

  function Info({ label, value }) {
    return (
      <div className="p-3 border border-ink-fade/30 rounded-md bg-paper">
        <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{label}</div>
        <div className="text-ink mt-1 break-all">{value}</div>
      </div>
    )
  }

  function renderPermissions() {
    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">PERMISSIONS</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">权限中心</h1>
          <p className="text-sm text-ink-soft mt-1">这些开关只控制本地工作台的授权状态，会保存在浏览器本地。</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Info label="已启用" value={`${enabledPermCount} / ${state.permissions.length}`} />
          <Info label="保存位置" value="浏览器 localStorage" />
        </div>

        <div className="flex flex-col gap-2">
          {state.permissions.map((p) => (
            <div key={p.id} className="p-3 border border-ink/20 rounded-md flex items-center gap-3 hover:border-ink/40 transition-colors">
              <div className="w-9 h-9 rounded-full bg-paper-2 border border-ink-fade/40 flex items-center justify-center shrink-0">
                <PermIcon id={p.id} className="w-4 h-4 text-ink-soft" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-ink truncate">{p.name}</div>
                <div className="font-mono text-[9px] tracking-wider text-ink-fade">{p.code} · {p.scope}</div>
              </div>
              <button
                onClick={async () => {
                  if (p.id === 'notify' && !p.enabled && 'Notification' in window) {
                    const result = await Notification.requestPermission()
                    if (result !== 'granted') {
                      return
                    }
                  }
                  dispatch({ type: 'TOGGLE_PERM', payload: p.id })
                }}
                className={`relative w-10 h-6 rounded-full border transition-colors ${p.enabled ? 'bg-ember border-ember' : 'bg-paper-2 border-ink-fade/60'}`}
                aria-label={`${p.enabled ? '关闭' : '开启'}${p.name}`}
              >
                <div className={`absolute top-0.5 w-4.5 h-4.5 rounded-full border bg-paper transition-all ${p.enabled ? 'left-[18px] border-ember' : 'left-0.5 border-ink-fade/60'}`} />
              </button>
            </div>
          ))}
        </div>
      </section>
    )
  }

  function renderAppearance() {
    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">APPEARANCE</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">外观</h1>
        </div>

        <SettingsGroup title="主题">
          <div className="flex gap-2 flex-wrap">
            {[
              { key: 'dark', label: '深色', icon: Moon },
              { key: 'light', label: '浅色', icon: Sun },
              { key: 'system', label: '跟随系统', icon: MonitorSmartphone },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => dispatch({ type: 'SET_THEME', payload: key })}
                className={`h-9 px-3 rounded-md text-sm border transition-colors flex items-center gap-1.5 ${state.theme === key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </SettingsGroup>

        <SettingsGroup title="强调色">
          <div className="flex gap-3">
            {ACCENT_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => dispatch({ type: 'SET_ACCENT', payload: c })}
                className="w-8 h-8 rounded-full relative transition-transform hover:scale-110"
                style={{ background: c, border: state.accentColor === c ? '2px solid var(--color-ink)' : '1px solid var(--color-ink-fade)' }}
                aria-label={`设置强调色 ${c}`}
              >
                {state.accentColor === c && <Check className="w-4 h-4 text-white absolute inset-0 m-auto" />}
              </button>
            ))}
          </div>
        </SettingsGroup>

        <SettingsGroup title="字体大小">
          <Segmented
            value={state.fontSize}
            options={[['small', '小'], ['medium', '中'], ['large', '大']]}
            onChange={(value) => dispatch({ type: 'SET_FONT_SIZE', payload: value })}
          />
        </SettingsGroup>

        <SettingsGroup title="界面密度">
          <Segmented
            value={state.density}
            options={[['compact', '紧凑'], ['comfortable', '舒适'], ['loose', '宽松']]}
            onChange={(value) => dispatch({ type: 'SET_DENSITY', payload: value })}
          />
        </SettingsGroup>

        <SettingsGroup title="动画效果">
          <Toggle enabled={state.animationsEnabled} onClick={() => dispatch({ type: 'SET_ANIMATIONS', payload: !state.animationsEnabled })} />
        </SettingsGroup>
      </section>
    )
  }

  function SettingsGroup({ title, children }) {
    return (
      <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3">
        <h3 className="font-hand text-lg text-ink">{title}</h3>
        {children}
      </div>
    )
  }

  function Segmented({ value, options, onChange }) {
    return (
      <div className="flex gap-2 flex-wrap">
        {options.map(([key, label]) => (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`h-9 px-4 rounded-md text-sm border transition-colors ${value === key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}
          >
            {label}
          </button>
        ))}
      </div>
    )
  }

  function Toggle({ enabled, onClick }) {
    return (
      <button
        onClick={onClick}
        className={`relative w-11 h-6 rounded-full border transition-colors ${enabled ? 'bg-ember border-ember' : 'bg-paper-2 border-ink-fade/60'}`}
      >
        <div className={`absolute top-0.5 w-4.5 h-4.5 rounded-full border bg-paper transition-all ${enabled ? 'left-[22px] border-ember' : 'left-0.5 border-ink-fade/60'}`} />
      </button>
    )
  }

  function renderTools() {
    const tc = state.toolsConfig || {}
    const TOOLS = [
      { id: 'web_search', name: '网页搜索', desc: '让模型通过 DuckDuckGo 查询最新信息(返回 title/url/snippet)。' },
      { id: 'fetch_url', name: '抓取链接', desc: '让模型把页面正文抓回来转 markdown 阅读。配合搜索使用。' },
      { id: 'run_js', name: '执行 JavaScript', desc: '在浏览器隔离 Worker 中跑纯 JS,5 秒超时,无 DOM/网络。' },
    ]
    const onToggle = (id) => {
      dispatch({ type: 'SET_TOOLS_CONFIG', payload: { [id]: !tc[id] } })
    }
    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">TOOLS</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">模型工具</h1>
          <p className="text-sm text-ink-soft mt-1">开启后,会按 OpenAI tool calling 协议把工具规格塞给模型;模型自行决定何时调用。需上游支持 <code>tools</code> 字段。</p>
        </div>
        <div className="flex flex-col gap-2">
          {TOOLS.map((t) => (
            <div key={t.id} className="p-3 border border-ink/20 rounded-md flex items-center gap-3 hover:border-ink/40 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-ink">{t.name}</div>
                <div className="font-mono text-[10px] tracking-wider text-ink-fade mt-0.5">{t.id}</div>
                <div className="text-xs text-ink-soft mt-1">{t.desc}</div>
              </div>
              <button
                onClick={() => onToggle(t.id)}
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${tc[t.id] ? 'bg-ember' : 'bg-ink-fade/40'}`}
                aria-pressed={!!tc[t.id]}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all ${tc[t.id] ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          ))}
        </div>
        <div className="p-4 border border-dashed border-ink-fade/40 rounded-md bg-paper-2 text-xs text-ink-soft">
          提示:工具调用最多迭代 5 轮(防止循环)。如果模型后端不支持 <code>tools</code> 字段会报错,关掉所有开关即可恢复纯文本对话。
        </div>
      </section>
    )
  }

  function renderShortcuts() {
    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">SHORTCUTS</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">快捷键</h1>
          <p className="text-sm text-ink-soft mt-1">当前版本只展示已经接入的快捷键。</p>
        </div>

        {SHORTCUTS.map((group) => (
          <div key={group.category} className="flex flex-col gap-2">
            <h3 className="font-hand text-lg text-ink">{group.category}</h3>
            <div className="flex flex-col gap-1">
              {group.items.map((item) => (
                <div key={item.name} className="flex items-center justify-between p-3 border border-ink/20 rounded-md hover:border-ink/40 transition-colors">
                  <span className="text-sm text-ink">{item.name}</span>
                  <div className="flex items-center gap-1">
                    {item.keys.map((k, i) => (
                      <span key={k} className="flex items-center gap-1">
                        <kbd className="inline-flex items-center h-6 px-1.5 rounded border border-ink-fade/60 bg-paper-2 text-[11px] font-mono text-ink-soft min-w-[24px] justify-center">{k}</kbd>
                        {i < item.keys.length - 1 && <span className="text-ink-ghost text-xs">+</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    )
  }

  function renderDataExport() {
    const handleExportSessions = () => {
      downloadJson(`sessions-${Date.now()}.json`, wrapSessionsExport(state.sessions))
      setDataMessage(`会话数据已导出 (schema v${SCHEMA_VERSION})。`)
    }

    const handleExportSettings = () => {
      downloadJson(`settings-${Date.now()}.json`, wrapSettingsExport({
        theme: state.theme,
        accentColor: state.accentColor,
        fontSize: state.fontSize,
        density: state.density,
        animationsEnabled: state.animationsEnabled,
        permissions: state.permissions,
        skillConfigs: state.skillConfigs,
      }))
      setDataMessage(`设置已导出 (schema v${SCHEMA_VERSION},不含 API Key)。`)
    }

    const handleImportFile = async (file) => {
      if (!file) return
      try {
        const text = await file.text()
        const parsed = parseImport(text)
        if (parsed.kind === 'sessions') {
          dispatch({ type: 'IMPORT_SESSIONS', payload: parsed.payload })
          setDataMessage(`已导入 ${parsed.payload.length} 个会话 (schema: ${parsed.schema})。`)
        } else if (parsed.kind === 'settings') {
          dispatch({ type: 'IMPORT_SETTINGS', payload: parsed.payload })
          setDataMessage(`已导入设置 (schema: ${parsed.schema})。`)
        }
        refreshStorage()
      } catch (err) {
        if (err instanceof InvalidExportError) {
          setDataMessage(`导入失败: ${err.reason}`)
        } else {
          setDataMessage(`导入失败: ${err?.message || err}`)
        }
      } finally {
        // 同一文件再次选择需要重置 input
        if (importInputRef.current) importInputRef.current.value = ''
      }
    }

    const handleClearTmp = () => {
      let cleared = 0
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('your-model-atelier:tmp:') || key.startsWith('tmp:')) {
            localStorage.removeItem(key)
            cleared += 1
          }
        }
      } catch (err) {
        setDataMessage(`本地存储不可访问 (${err?.name || 'Error'})。`)
        return
      }
      refreshStorage()
      setDataMessage(`已清理 ${cleared} 项本地临时数据。`)
    }

    const handleClearAll = () => {
      if (!confirm('确定清除所有本地会话、设置和历史记录？此操作不可撤销。')) return
      const result = clearPersistedState()
      dispatch({ type: 'CLEAR_ALL_DATA' })
      if (result?.ok) {
        setDataMessage('所有本地数据已清除。')
      } else {
        setDataMessage(`内存状态已重置;localStorage 不可写 (${result?.reason || 'unknown'}),刷新后将以干净状态启动。`)
      }
      refreshStorage()
    }

    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">DATA & EXPORT</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">数据 & 导出</h1>
        </div>

        <SettingsGroup title="导出数据">
          <div className="flex flex-wrap gap-2">
            <button onClick={handleExportSessions} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5">
              <FileJson className="w-3.5 h-3.5" />
              导出会话
            </button>
            <button onClick={handleExportSettings} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" />
              导出设置
            </button>
          </div>
        </SettingsGroup>

        <SettingsGroup title="导入数据">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => handleImportFile(e.target.files?.[0])}
            />
            <button
              onClick={() => importInputRef.current?.click()}
              className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              选择 JSON 文件
            </button>
            <span className="text-xs text-ink-soft">支持当前 schema (v{SCHEMA_VERSION}) 或老版本裸 sessions 数组,导入前会做结构校验。</span>
          </div>
        </SettingsGroup>

        <SettingsGroup title="存储统计">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Stat icon={HardDrive} value={formatBytes(storageBytes)} label="本地存储" />
            <Stat icon={MessageSquare} value={String(state.sessions.length)} label="会话数量" />
            <Stat icon={CheckCircle2} value={String(state.history.length)} label="历史记录" />
          </div>
        </SettingsGroup>

        <SettingsGroup title="本地清理">
          <div className="flex flex-wrap gap-2">
            <button onClick={handleClearTmp} className="h-9 px-4 border border-ink/70 rounded-md text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" />
              清理临时数据
            </button>
            <button onClick={handleClearAll} className="h-9 px-4 border border-ember-line rounded-md text-sm text-ember hover:bg-ember-soft transition-colors flex items-center gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />
              清除所有本地数据
            </button>
          </div>
          {dataMessage && <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{dataMessage}</div>}
        </SettingsGroup>

        <div className="p-4 border border-dashed border-ember-line rounded-md bg-ember-soft/30 text-sm text-ember flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          清除数据只影响当前浏览器，不会修改后端 .env 模型配置。
        </div>
      </section>
    )
  }

  function Stat({ icon: Icon, value, label }) {
    return (
      <div className="p-3 border border-ink-fade/30 rounded-md flex items-center gap-3">
        <Icon className="w-5 h-5 text-ink-fade" />
        <div>
          <span className="text-sm text-ink">{value}</span>
          <span className="text-xs text-ink-soft block">{label}</span>
        </div>
      </div>
    )
  }

  const renderActive = () => {
    switch (activeNav) {
      case '系统诊断':
        return renderDiagnostics()
      case '账户':
        return renderAccount()
      case '权限中心':
        return renderPermissions()
      case '工具':
        return renderTools()
      case '外观':
        return renderAppearance()
      case '快捷键':
        return renderShortcuts()
      case '数据 & 导出':
        return renderDataExport()
      default:
        return renderAccount()
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="w-[220px] border-r border-dashed border-ink-fade/50 p-4 overflow-y-auto bg-paper-2">
        <div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade mb-3">SETTINGS</div>
        <div className="flex flex-col gap-1">
          {['系统诊断', ...SETTINGS_NAV].map((item) => (
            <button
              key={item}
              onClick={() => setActiveNav(item)}
              className={`text-left px-3 py-2 rounded-md text-sm transition-colors ${
                activeNav === item ? 'bg-paper border border-ink-fade/50 text-ink' : 'text-ink-soft hover:bg-paper/70'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl">
          {renderActive()}
        </div>
      </main>
    </div>
  )
}
