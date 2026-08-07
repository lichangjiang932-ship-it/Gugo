import { BookOpen, Check, Circle, History, ImagePlus, ListChecks, Mic, Monitor, Moon, Plug, RotateCcw, Shield, ShieldCheck, Sun, Users } from 'lucide-react'
import { useState } from 'react'
import IntegrationsPanel from '../IntegrationsPanel.jsx'
import { ROUTE_READINESS } from '../../config/routeReadiness.js'
import { THEME_OPTIONS } from '../../lib/themeMode.js'
import { readDesktopPetPreferences, validateDesktopPetImage, writeDesktopPetPreferences } from '../../lib/desktopPetPreferences.js'

const ACCENT_COLORS = ['#E86A3C', '#D94A64', '#B45DE5', '#7459E8', '#3D6FE0', '#2E8FA3', '#23A68B', '#A5C97A', '#D4A4FF', '#D59B32']
const THEME_ICONS = { dark: Moon, light: Sun, white: Circle, system: Monitor }

function Group({ title, children }) {
  return <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3"><h3 className="font-hand text-lg text-ink">{title}</h3>{children}</div>
}
function Toggle({ enabled, onClick }) {
  return <button onClick={onClick} className={`relative w-11 h-6 rounded-full border transition-colors ${enabled ? 'bg-ember border-ember' : 'bg-paper-2 border-ink-fade/60'}`}><div className={`absolute top-0.5 w-4.5 h-4.5 rounded-full border bg-paper transition-all ${enabled ? 'left-[22px] border-ember' : 'left-0.5 border-ink-fade/60'}`} /></button>
}
function Segmented({ value, options, onChange }) {
  return <div className="flex gap-2 flex-wrap">{options.map(([key, label]) => <button key={key} onClick={() => onChange(key)} className={`h-9 px-4 rounded-md text-sm border ${value === key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft'}`}>{label}</button>)}</div>
}
function Info({ label, value }) {
  return <div className="p-3 border border-ink-fade/30 rounded-md bg-paper"><div className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{label}</div><div className="text-ink mt-1 break-all">{value}</div></div>
}

export function SettingsFeatureHub({ navigate, t }) {
  const links = [
    ['/task', ListChecks, t('nav.task'), '后台任务、Artifacts 与运行记录。'], ['/approvals', ShieldCheck, t('approvals.nav'), '后台任务需要批准时在这里排队。'],
    ['/memory', BookOpen, t('nav.memory'), '长期记忆、置顶记忆与 Agent 关联。'], ['/desk', BookOpen, t('nav.desk') || '书桌', '便笺、灵感和 TODO。'],
    ['/agents', Users, '人物与性格', '集中管理人物、性格、技能和角色卡。'], ['/mcp', Plug, t('nav.mcp'), 'MCP 服务、工具、资源和 prompts。'],
    ['/history', History, t('nav.history'), '运行历史、生成记录和可追溯结果。'],
  ]
  return <section className="flex flex-col gap-5 animate-float-up"><div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">FEATURES</span><h1 className="font-hand text-[28px] text-ink mt-1.5">功能入口</h1><p className="text-sm text-ink-soft mt-1">低频能力集中在这里，主导航只保留高频入口。</p></div><div className="grid grid-cols-1 md:grid-cols-2 gap-3">{links.map(([path, Icon, title, desc]) => { const level = ROUTE_READINESS[path]; const badge = ['preview', 'wip'].includes(level) ? t(`routeReadiness.${level}`) : null; return <button key={path} type="button" onClick={() => navigate(path)} className="text-left p-4 border border-ink/30 rounded-md bg-paper hover:bg-paper-2 flex items-start gap-3"><span className="w-9 h-9 rounded-md border border-ink-fade/40 flex items-center justify-center"><Icon className="w-4 h-4 text-ink-soft" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="text-sm text-ink">{title}</span>{badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-paper-2 text-ink-fade">{badge}</span>}</span><span className="block text-xs text-ink-soft mt-1">{desc}</span></span></button> })}</div></section>
}

export function SettingsPermissionsPanel({ navigate, t, state, enabledPermCount }) {
  return <section className="flex flex-col gap-5 animate-float-up"><div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">PERMISSIONS</span><h1 className="font-hand text-[28px] text-ink mt-1.5">{t('nav.permissions')}</h1><p className="text-sm text-ink-soft mt-1">{t('settings.permissionsSubtitle')}</p></div><div className="grid grid-cols-1 md:grid-cols-3 gap-3"><Info label={t('settings.workbenchPolicy')} value={`${enabledPermCount} / ${state.permissions.length}`} /><Info label={t('settings.browserAuthorization')} value={t('permissionsDashboard.refresh')} /><Info label={t('settings.dangerousTools')} value={t('permissionsDashboard.serverEnforced')} /></div><div className="p-5 rounded-xl border border-ink/20 bg-paper-2 flex items-center gap-4"><ShieldCheck className="w-6 h-6 text-ember" /><div className="flex-1"><h2 className="text-base text-ink">{t('settings.permissionCardTitle')}</h2><p className="text-sm text-ink-soft mt-1">{t('settings.permissionCardDescription')}</p></div><button onClick={() => navigate('/permissions')} className="h-10 px-4 rounded-md bg-ink text-paper text-sm">{t('settings.openPermissions')}</button></div><Group title={t('settings.policySummary')}><p className="text-xs text-ink-fade">{t('settings.policySummaryHint')}</p><div className="grid grid-cols-1 md:grid-cols-2 gap-2">{state.permissions.map((permission) => { const Icon = permission.id === 'mic' ? Mic : Shield; return <div key={permission.id} className="p-3 border border-ink-fade/30 rounded-md flex items-center gap-3"><Icon className="w-4 h-4 text-ink-soft" /><div className="flex-1"><div className="text-sm text-ink">{permission.name}</div><div className="font-mono text-[9px] text-ink-fade">{permission.code}</div></div><span className={`text-xs ${permission.enabled ? 'text-emerald-600' : 'text-ink-fade'}`}>{permission.enabled ? t('settings.policyAllowed') : t('settings.policyBlocked')}</span></div> })}</div></Group></section>
}

export function SettingsAppearancePanel({ t, state, dispatch }) {
  return <section className="flex flex-col gap-5 animate-float-up"><div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">APPEARANCE</span><h1 className="font-hand text-[28px] text-ink mt-1.5">{t('settings.appearance')}</h1><p className="text-sm text-ink-soft mt-1">{t('settings.appearanceSubtitle')}</p></div><div className="rounded-2xl border border-ink/20 bg-paper p-5 flex flex-col gap-3"><div className="max-w-md p-3 rounded-xl bg-paper-2 text-sm text-ink">{t('settings.appearancePreviewAssistant')}</div><div className="max-w-xs self-end p-3 rounded-xl bg-ember-soft text-sm text-ink">{t('settings.appearancePreviewUser')}</div></div><Group title="主题"><div className="flex gap-2 flex-wrap">{THEME_OPTIONS.map(({ key, labelKey }) => { const Icon = THEME_ICONS[key]; return <button key={key} onClick={() => dispatch({ type: 'SET_THEME', payload: key })} className={`h-9 px-3 rounded-md text-sm border flex items-center gap-1.5 ${state.theme === key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft'}`}><Icon className="w-3.5 h-3.5" />{t(labelKey)}</button> })}</div></Group><Group title="强调色"><div className="flex flex-wrap gap-3">{ACCENT_COLORS.map((color) => <button key={color} onClick={() => dispatch({ type: 'SET_ACCENT', payload: color })} className="w-8 h-8 rounded-full relative" style={{ background: color, border: state.accentColor === color ? '2px solid var(--color-ink)' : '1px solid var(--color-ink-fade)' }} aria-label={`设置强调色 ${color}`}>{state.accentColor === color && <Check className="w-4 h-4 text-white absolute inset-0 m-auto" />}</button>)}</div><div className="flex items-center justify-between"><span className="text-sm text-ink">强色调模式</span><Toggle enabled={!!state.strongAccent} onClick={() => dispatch({ type: 'SET_STRONG_ACCENT', payload: !state.strongAccent })} /></div></Group><Group title="字体大小"><Segmented value={state.fontSize} options={[['small', '小'], ['medium', '中'], ['large', '大']]} onChange={(value) => dispatch({ type: 'SET_FONT_SIZE', payload: value })} /></Group><Group title="界面密度"><Segmented value={state.density} options={[['compact', '紧凑'], ['comfortable', '舒适'], ['loose', '宽松']]} onChange={(value) => dispatch({ type: 'SET_DENSITY', payload: value })} /></Group><Group title="动画效果"><Toggle enabled={state.animationsEnabled} onClick={() => dispatch({ type: 'SET_ANIMATIONS', payload: !state.animationsEnabled })} /></Group></section>
}

export function SettingsPetPanel({ t }) {
  const [preferences, setPreferences] = useState(readDesktopPetPreferences)
  const [message, setMessage] = useState('')
  const update = (next) => {
    const value = { ...preferences, ...next }
    writeDesktopPetPreferences(value)
    setPreferences(value)
  }
  const selectImage = (event) => {
    const file = event.target.files?.[0]
    const error = validateDesktopPetImage(file)
    if (error) { setMessage(t(`settings.petImageError.${error}`)); return }
    const reader = new FileReader()
    reader.onload = () => { update({ customImage: String(reader.result || '') }); setMessage(t('settings.petSaved')) }
    reader.onerror = () => setMessage(t('settings.petReadFailed'))
    reader.readAsDataURL(file)
  }
  return <section className="flex flex-col gap-5 animate-float-up"><div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">DESKTOP PET</span><h1 className="font-hand text-[28px] text-ink mt-1.5">{t('settings.pet')}</h1><p className="text-sm text-ink-soft mt-1">{t('settings.petSubtitle')}</p></div><div className="grid gap-4 md:grid-cols-[220px_1fr]"><div className="min-h-56 rounded-2xl border border-ink/15 bg-paper-2 grid place-items-center overflow-hidden">{preferences.customImage ? <img src={preferences.customImage} alt={t('settings.petPreview')} className="max-w-40 max-h-40 object-contain" style={{ transform: `scale(${preferences.scale})` }} /> : <div className="text-center text-ink-fade"><ImagePlus className="w-10 h-10 mx-auto" /><span className="mt-2 block text-xs">{t('settings.petDefault')}</span></div>}</div><div className="flex flex-col gap-4"><Group title={t('settings.petImage')}><p className="text-xs text-ink-fade">{t('settings.petImageHint')}</p><label className="h-10 px-4 rounded-md bg-ink text-paper text-sm inline-flex items-center gap-2 self-start cursor-pointer"><ImagePlus className="w-4 h-4" />{t('settings.petChoose')}<input type="file" accept="image/png,image/webp,image/gif" className="sr-only" onChange={selectImage} /></label></Group><Group title={t('settings.petSize')}><input aria-label={t('settings.petSize')} type="range" min="0.6" max="1.8" step="0.1" value={preferences.scale} onChange={(event) => update({ scale: Number(event.target.value) })} /><span className="text-xs text-ink-fade">{Math.round(preferences.scale * 100)}%</span></Group><button type="button" onClick={() => { update({ customImage: '', scale: 1 }); setMessage(t('settings.petResetDone')) }} className="h-9 px-3 border border-ink/20 rounded-md text-sm text-ink-soft flex items-center gap-2 self-start"><RotateCcw className="w-4 h-4" />{t('settings.petReset')}</button>{message && <p role="status" className="text-xs text-ink-soft">{message}</p>}</div></div></section>
}

export function SettingsIntegrationsPanel({ navigate, t }) {
  return <section className="flex flex-col gap-5 animate-float-up"><div><span className="font-mono text-[9px] tracking-[0.22em] text-ink-fade">INTEGRATIONS</span><h1 className="font-hand text-[28px] text-ink mt-1.5">{t('settings.integrations')}</h1><p className="text-sm text-ink-soft mt-1">{t('settings.integrationsSubtitle')}</p></div><div className="p-4 rounded-lg border border-ink-fade/40 bg-paper flex items-center justify-between gap-4"><div><h2 className="text-sm text-ink">{t('access.manageInAccess')}</h2><p className="text-xs text-ink-soft mt-1">{t('access.manageHint')}</p></div><button onClick={() => navigate('/access')} className="h-9 px-4 rounded-md bg-ink text-paper text-sm">{t('access.manageInAccess')}</button></div><div className="p-3 border border-dashed border-ink-fade/40 rounded-md bg-paper-2 text-sm text-ink-soft">{t('integrations.visionAssistHint')}</div><IntegrationsPanel kind="vision_assist" t={t} /></section>
}
