import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Mic, Bell, HardDrive, Database, Camera, RefreshCw, Pause, Terminal, FilePen, FileText, ShieldCheck } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import { useAppContext } from '../store/AppContext'
import {
  probeLocalStorage,
  probeStorage,
  probeNotifications,
  probeMedia,
} from '../lib/permissionsProbes.js'
import {
  GATEABLE_TOOLS,
  fetchToolPermissions,
  setToolPermission,
} from '../lib/toolPermissionClient'
import { getLocalFileAccessApi, setWorkspaceTrustApi } from '../lib/localFileAccessClient.js'
import RiskOverridesPanel from '../components/RiskOverridesPanel.jsx'

// 5 个固定能力。Key 来自 i18n permissionsDashboard 域。
const ITEMS = [
  { id: 'localStorage', icon: Database, nameKey: 'itemLocalStorageName', scopeKey: 'itemLocalStorageScope', requestable: false },
  { id: 'storage',      icon: HardDrive, nameKey: 'itemStorageName',      scopeKey: 'itemStorageScope',      requestable: false },
  { id: 'notifications',icon: Bell,      nameKey: 'itemNotificationsName',scopeKey: 'itemNotificationsScope',requestable: true  },
  { id: 'microphone',   icon: Mic,       nameKey: 'itemMicName',          scopeKey: 'itemMicScope',          requestable: true  },
  { id: 'camera',       icon: Camera,    nameKey: 'itemCameraName',       scopeKey: 'itemCameraScope',       requestable: true  },
]

// 5 个状态对应的颜色 class（granted绿/denied红/prompt黄/unsupported灰/unknown灰）
const STATE_COLOR = {
  granted: 'text-emerald-600',
  denied: 'text-red-600',
  prompt: 'text-amber-600',
  unsupported: 'text-ink-fade',
  unknown: 'text-ink-fade',
}
const STATE_DOT = {
  granted: 'bg-emerald-500',
  denied: 'bg-red-500',
  prompt: 'bg-amber-500',
  unsupported: 'bg-ink-fade',
  unknown: 'bg-ink-fade',
}
const STATE_KEY = {
  granted: 'stateGranted',
  denied: 'stateDenied',
  prompt: 'statePrompt',
  unsupported: 'stateUnsupported',
  unknown: 'stateUnknown',
}

// 后端真实工具图标映射（工具 gate）
const toolIconMap = {
  bash_exec: Terminal,
  write_file: FilePen,
  edit_file: FileText,
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

function emptyResults() {
  return ITEMS.reduce((acc, it) => {
    acc[it.id] = { state: 'unknown', detail: null }
    return acc
  }, {})
}

export default function PermissionsDashboard() {
  const { t } = useT()
  const { state: appState, dispatch } = useAppContext()
  const [results, setResults] = useState(() => emptyResults())
  const [checking, setChecking] = useState(false)

  // 后端权威的 per-user 工具 gate（显式覆盖 map: { toolName: false }）；默认放行。
  const [toolOverrides, setToolOverrides] = useState({})
  const [toolError, setToolError] = useState(null)
  const [localFiles, setLocalFiles] = useState(null)
  const [localFileError, setLocalFileError] = useState(null)
  const [trustBusyPath, setTrustBusyPath] = useState('')

  useEffect(() => {
    let alive = true
    fetchToolPermissions()
      .then((perms) => { if (alive) setToolOverrides(perms || {}) })
      .catch((err) => { if (alive) setToolError(err.message) })
    return () => { alive = false }
  }, [])

  const refreshLocalFiles = useCallback(async () => {
    try {
      setLocalFiles(await getLocalFileAccessApi())
      setLocalFileError(null)
    } catch (error) {
      setLocalFileError(error?.message || t('localFiles.workspaceTrustLoadFailed'))
    }
  }, [t])

  useEffect(() => {
    Promise.resolve().then(refreshLocalFiles)
  }, [refreshLocalFiles])

  const changeWorkspaceTrust = async (rootPath, trusted) => {
    setTrustBusyPath(rootPath)
    try {
      const status = await setWorkspaceTrustApi({ path: rootPath, trusted })
      setLocalFiles(status)
      setLocalFileError(null)
    } catch (error) {
      setLocalFileError(error?.message || t('localFiles.workspaceTrustFailed'))
    } finally {
      setTrustBusyPath('')
    }
  }

  // 某工具是否启用：无显式覆盖 → 默认开；显式 false → 关。
  const isToolEnabled = (id) => toolOverrides[id] !== false

  const toggleTool = async (id) => {
    const next = !isToolEnabled(id)
    // 乐观更新
    setToolOverrides((prev) => ({ ...prev, [id]: next }))
    try {
      const perms = await setToolPermission(id, next)
      setToolOverrides(perms || {})
      setToolError(null)
    } catch (err) {
      // 回滚乐观更新
      setToolOverrides((prev) => ({ ...prev, [id]: !next }))
      setToolError(err.message)
    }
  }

  const runChecks = useCallback(async () => {
    setChecking(true)
    try {
      const [ls, st, nt, mic, cam] = await Promise.all([
        Promise.resolve(probeLocalStorage()),
        probeStorage(),
        Promise.resolve(probeNotifications()),
        probeMedia('microphone'),
        probeMedia('camera'),
      ])
      setResults({
        localStorage: ls,
        storage: st,
        notifications: nt,
        microphone: mic,
        camera: cam,
      })
    } finally {
      setChecking(false)
    }
  }, [])

  // 进页时 query 一次；不再轮询。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time probe (async setState after await)
    runChecks()
  }, [runChecks])

  const requestPermission = useCallback(async (id) => {
    if (id === 'notifications') {
      if (typeof window === 'undefined' || !('Notification' in window) || !window.Notification) return
      try {
        await window.Notification.requestPermission()
      } catch {
        // 用户取消或不支持都不报错
      }
      const next = probeNotifications()
      setResults((r) => ({ ...r, notifications: next }))
      return
    }
    if (id === 'microphone' || id === 'camera') {
      const constraints = id === 'microphone' ? { audio: true } : { video: true }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        // 立即释放设备，不长留
        if (stream && typeof stream.getTracks === 'function') {
          for (const track of stream.getTracks()) {
            try { track.stop() } catch { /* 忽略 */ }
          }
        }
      } catch {
        // denied / NotAllowedError / NotFoundError 都吞掉，状态由后续 probe 反映
      }
      const next = await probeMedia(id === 'microphone' ? 'microphone' : 'camera')
      setResults((r) => ({ ...r, [id]: next }))
    }
  }, [])

  const counts = useMemo(() => {
    let granted = 0, denied = 0, prompt = 0, unsupported = 0
    for (const it of ITEMS) {
      const s = results[it.id]?.state
      if (s === 'granted') granted++
      else if (s === 'denied') denied++
      else if (s === 'prompt') prompt++
      else if (s === 'unsupported') unsupported++
    }
    return { granted, denied, prompt, unsupported }
  }, [results])

  const gatedOffCount = GATEABLE_TOOLS.filter((tool) => !isToolEnabled(tool.id)).length

  const stats = [
    { label: t('permissionsDashboard.statEnabled'),     value: String(counts.granted),     tone: 'ember' },
    { label: t('permissionsDashboard.statDenied'),      value: String(counts.denied),      tone: '' },
    { label: t('permissionsDashboard.toolsEnabled'), value: `${GATEABLE_TOOLS.length - gatedOffCount}/${GATEABLE_TOOLS.length}`, tone: 'cyan' },
    { label: t('permissionsDashboard.toolGate'), value: t('permissionsDashboard.serverEnforced'), tone: '' },
  ]

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 p-8 overflow-y-auto">
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">PERMISSIONS</span>
            <h1 className="font-hand text-[28px] text-ink mt-1.5">{t('permissionsDashboard.title')}</h1>
            <p className="font-hand text-base text-ink-soft mt-1">
              {t('permissionsDashboard.subtitle')}
            </p>
          </div>
          <button
            onClick={runChecks}
            disabled={checking}
            className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-hand text-sm text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? t('permissionsDashboard.checking') : t('permissionsDashboard.refresh')}
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

        {toolError && (
          <div className="mb-4 px-4 py-2.5 border border-dashed border-ember/60 rounded-md font-hand text-sm text-ember">
            工具权限同步失败：{toolError}
          </div>
        )}

        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">WORKBENCH</span>
          <span className="font-hand text-base text-ink-soft">{t('permissionsDashboard.policyTitle')}</span>
        </div>
        <p className="text-xs text-ink-fade mb-2">{t('permissionsDashboard.policyHint')}</p>
        <div className="border border-ink/30 rounded-md overflow-hidden mb-6">
          {(appState.permissions || []).map((permission, index) => {
            const IconComp = permission.id === 'mic' ? Mic : Bell
            return (
              <div
                key={permission.id}
                className={`px-4 py-3 flex items-center gap-3 ${index < appState.permissions.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''}`}
              >
                <div className="w-8 h-8 rounded-md border border-ink-fade/60 flex items-center justify-center bg-paper-2">
                  <IconComp className="w-4 h-4 text-ink-soft" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink">{permission.name}</div>
                  <div className="text-xs text-ink-fade">{permission.scope}</div>
                </div>
                <span className={`text-xs ${permission.enabled ? 'text-emerald-600' : 'text-ink-fade'}`}>
                  {permission.enabled ? t('permissionsDashboard.policyAllowed') : t('permissionsDashboard.policyBlocked')}
                </span>
                <PermSwitch
                  on={permission.enabled}
                  onToggle={() => dispatch({ type: 'TOGGLE_PERM', payload: permission.id })}
                  label={`${permission.enabled ? t('permissionsDashboard.disable') : t('permissionsDashboard.enable')} ${permission.name}`}
                />
              </div>
            )
          })}
        </div>

        <RiskOverridesPanel />

        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">WORKSPACE TRUST</span>
          <span className="font-hand text-base text-ink-soft">{t('localFiles.workspaceTrustManage')}</span>
        </div>
        <p className="mb-2 text-xs text-ink-fade">{t('localFiles.workspaceTrustManageHint')}</p>
        {localFileError && (
          <div className="mb-3 rounded-md border border-dashed border-ember/60 px-4 py-2.5 text-sm text-ember">
            {localFileError}
          </div>
        )}
        <div className="mb-6 overflow-hidden rounded-md border border-ink/30">
          {(localFiles?.grants || []).filter((grant) => grant.resourceType === 'directory').length === 0 ? (
            <div className="px-4 py-5 text-sm text-ink-fade">{t('localFiles.workspaceTrustEmpty')}</div>
          ) : (localFiles?.grants || []).filter((grant) => grant.resourceType === 'directory').map((grant, index, grants) => {
            const trust = (localFiles?.trustedWorkspaces || []).find((item) => (
              String(item.rootPath || '').toLowerCase() === String(grant.path || '').toLowerCase()
            ))
            const trusted = !!trust?.trusted
            const effective = trust?.effective
            return (
              <div
                key={grant.id}
                className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${index < grants.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''}`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${trusted ? 'border-emerald-500/40 bg-emerald-50 text-emerald-700' : 'border-ink-fade/50 bg-paper-2 text-ink-fade'}`}>
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-ink" title={grant.path}>{grant.path}</div>
                    <div className="mt-1 text-xs text-ink-fade">
                      {trusted ? t('localFiles.workspaceTrusted') : t('localFiles.workspaceTrustOff')}
                      {trusted && trust?.config?.present === false ? ` · ${t('localFiles.workspaceConfigMissing')}` : ''}
                      {trusted && trust?.config?.valid === false ? ` · ${trust.config.error?.message || t('localFiles.workspaceConfigInvalid')}` : ''}
                    </div>
                    {effective && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Object.entries(effective).map(([name, enabled]) => (
                          <span key={name} className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${enabled ? 'border-emerald-500/30 text-emerald-700' : 'border-ink-fade/40 text-ink-fade line-through'}`}>
                            {name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => changeWorkspaceTrust(grant.path, !trusted)}
                  disabled={trustBusyPath === grant.path || !grant.available}
                  className={`h-8 shrink-0 rounded-md border px-3 text-xs transition-colors disabled:opacity-50 ${trusted ? 'border-ink-fade/60 text-ink-soft hover:text-ink' : 'border-emerald-600/40 text-emerald-700 hover:bg-emerald-50'}`}
                >
                  {trustBusyPath === grant.path
                    ? t('localFiles.workspaceTrustWorking')
                    : trusted ? t('localFiles.workspaceUntrustAction') : t('localFiles.workspaceTrustAction')}
                </button>
              </div>
            )
          })}
        </div>

        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">TOOLS</span>
          <span className="font-hand text-base text-ink-soft">真实后端工具（后端 gate：关闭后即使前端被绕过，工具入口也会拒绝执行）</span>
        </div>
        <div className="border border-ink/30 rounded-md overflow-hidden mb-6">
          <div className="px-4 py-2.5 border-b border-dashed border-ink-fade/50 grid grid-cols-[40px_1.4fr_1fr_1fr_80px] gap-3 items-center bg-paper-2">
            <span />
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">工具</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">范围</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">状态</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">开关</span>
          </div>
          {GATEABLE_TOOLS.map((tool, i) => {
            const IconComp = toolIconMap[tool.id] || Terminal
            const on = isToolEnabled(tool.id)
            return (
              <div
                key={tool.id}
                className={`px-4 py-3 grid grid-cols-[40px_1.4fr_1fr_1fr_80px] gap-3 items-center ${
                  i < GATEABLE_TOOLS.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''
                }`}
                style={{ opacity: on ? 1 : 0.55 }}
              >
                <div className="w-7 h-7 rounded-md border border-ink-fade/60 flex items-center justify-center bg-paper">
                  <IconComp className="w-3.5 h-3.5 text-ink-soft" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-sm text-ink">{tool.name}</span>
                  <span className="font-mono text-[9px] tracking-wider text-ink-fade">{tool.id}</span>
                </div>
                <span className="text-sm text-ink-soft">{tool.scope}</span>
                <span className="text-sm text-ink-soft">{on ? '已开启' : '已关闭'}</span>
                <PermSwitch on={on} onToggle={() => toggleTool(tool.id)} label={`${on ? '关闭' : '开启'}${tool.name}`} />
              </div>
            )
          })}
        </div>

        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">BROWSER</span>
          <span className="font-hand text-base text-ink-soft">浏览器本地权限</span>
        </div>
        <div className="border border-ink/30 rounded-md overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dashed border-ink-fade/50 grid grid-cols-[40px_1.4fr_1fr_1fr_90px] gap-3 items-center bg-paper-2">
            <span />
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t('permissionsDashboard.capability')}</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t('permissionsDashboard.scope')}</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t('permissionsDashboard.status')}</span>
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t('permissionsDashboard.action')}</span>
          </div>
          {ITEMS.map((item, i) => {
            const IconComp = item.icon
            const result = results[item.id] ?? { state: 'unknown' }
            const state = result.state || 'unknown'
            const colorCls = STATE_COLOR[state] || STATE_COLOR.unknown
            const dotCls = STATE_DOT[state] || STATE_DOT.unknown
            const stateLabel = t(`permissionsDashboard.${STATE_KEY[state] || 'stateUnknown'}`)
            // 只有 requestable 的能力，且当前为 prompt（或 denied 想再试一次），才显示「请求」
            const showRequest = item.requestable && (state === 'prompt' || state === 'denied')
            return (
              <div
                key={item.id}
                className={`px-4 py-3 grid grid-cols-[40px_1.4fr_1fr_1fr_90px] gap-3 items-center ${
                  i < ITEMS.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''
                }`}
              >
                <div className="w-7 h-7 rounded-md border border-ink-fade/60 flex items-center justify-center bg-paper">
                  <IconComp className="w-3.5 h-3.5 text-ink-soft" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-sm text-ink">{t(`permissionsDashboard.${item.nameKey}`)}</span>
                  <span className="font-mono text-[9px] tracking-wider text-ink-fade uppercase">{item.id}</span>
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-sm text-ink-soft">{t(`permissionsDashboard.${item.scopeKey}`)}</span>
                  {result.detail ? (
                    <span className="font-mono text-[10px] text-ink-fade">{result.detail}</span>
                  ) : null}
                </div>
                <span className={`text-sm flex items-center gap-1.5 ${colorCls}`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotCls}`} />
                  {stateLabel}
                </span>
                <div>
                  {showRequest ? (
                    <button
                      onClick={() => requestPermission(item.id)}
                      className="h-7 px-2.5 border border-ink-fade/60 rounded-md text-xs text-ink hover:border-ember hover:text-ember transition-colors flex items-center gap-1"
                    >
                      <Pause className="w-3 h-3 hidden" />
                      {t('permissionsDashboard.request')}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
