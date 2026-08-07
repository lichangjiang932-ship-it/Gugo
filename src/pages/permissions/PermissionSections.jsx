import { motion } from 'framer-motion'
import { Bell, Mic, ShieldCheck, Terminal } from 'lucide-react'
import RiskOverridesPanel from '../../components/RiskOverridesPanel.jsx'
import { GATEABLE_TOOLS } from '../../lib/toolPermissionClient'
import { PERMISSION_ITEMS, STATE_COLOR, STATE_DOT, STATE_KEY, TOOL_ICONS } from './permissionViewConfig.js'

export function PermissionStats({ controller, t }) {
  const stats = [
    { label: t('permissionsDashboard.statEnabled'), value: String(controller.counts.granted), tone: 'ember' },
    { label: t('permissionsDashboard.statDenied'), value: String(controller.counts.denied), tone: '' },
    { label: t('permissionsDashboard.toolsEnabled'), value: `${GATEABLE_TOOLS.length - controller.gatedOffCount}/${GATEABLE_TOOLS.length}`, tone: 'cyan' },
    { label: t('permissionsDashboard.toolGate'), value: t('permissionsDashboard.serverEnforced'), tone: '' },
  ]
  return <div className="mb-5 grid grid-cols-2 gap-3.5 lg:grid-cols-4">{stats.map((stat, index) => <motion.div key={stat.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.08 }} className="rounded-md border border-ink/30 bg-paper p-3.5"><span className={`font-mono text-[9px] tracking-wider ${stat.tone === 'ember' ? 'text-ember' : stat.tone === 'cyan' ? 'text-cyan' : 'text-ink-fade'}`}>{stat.label}</span><div className="mt-1.5 font-hand text-[26px] text-ink">{stat.value}</div></motion.div>)}</div>
}

export function WorkbenchPolicySection({ appState, dispatch, t }) {
  return (
    <><SectionTitle eyebrow="WORKBENCH" title={t('permissionsDashboard.policyTitle')} /><p className="mb-2 text-xs text-ink-fade">{t('permissionsDashboard.policyHint')}</p><div className="mb-6 overflow-hidden rounded-md border border-ink/30">{(appState.permissions || []).map((permission, index) => { const Icon = permission.id === 'mic' ? Mic : Bell; return <div key={permission.id} className={`flex items-center gap-3 px-4 py-3 ${index < appState.permissions.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''}`}><div className="flex h-8 w-8 items-center justify-center rounded-md border border-ink-fade/60 bg-paper-2"><Icon className="h-4 w-4 text-ink-soft" /></div><div className="min-w-0 flex-1"><div className="text-sm text-ink">{permission.name}</div><div className="text-xs text-ink-fade">{permission.scope}</div></div><span className={`text-xs ${permission.enabled ? 'text-emerald-600' : 'text-ink-fade'}`}>{permission.enabled ? t('permissionsDashboard.policyAllowed') : t('permissionsDashboard.policyBlocked')}</span><PermSwitch on={permission.enabled} onToggle={() => dispatch({ type: 'TOGGLE_PERM', payload: permission.id })} label={`${permission.enabled ? t('permissionsDashboard.disable') : t('permissionsDashboard.enable')} ${permission.name}`} /></div> })}</div><RiskOverridesPanel /></>
  )
}

export function WorkspaceTrustSection({ controller, t }) {
  const grants = (controller.localFiles?.grants || []).filter((grant) => grant.resourceType === 'directory')
  return (
    <><SectionTitle eyebrow="WORKSPACE TRUST" title={t('localFiles.workspaceTrustManage')} /><p className="mb-2 text-xs text-ink-fade">{t('localFiles.workspaceTrustManageHint')}</p>{controller.localFileError && <div className="mb-3 rounded-md border border-dashed border-ember/60 px-4 py-2.5 text-sm text-ember">{controller.localFileError}</div>}<div className="mb-6 overflow-hidden rounded-md border border-ink/30">{grants.length === 0 ? <div className="px-4 py-5 text-sm text-ink-fade">{t('localFiles.workspaceTrustEmpty')}</div> : grants.map((grant, index) => <WorkspaceTrustRow key={grant.id} controller={controller} grant={grant} last={index === grants.length - 1} t={t} />)}</div></>
  )
}

function WorkspaceTrustRow({ controller, grant, last, t }) {
  const trust = (controller.localFiles?.trustedWorkspaces || []).find((item) => String(item.rootPath || '').toLowerCase() === String(grant.path || '').toLowerCase())
  const trusted = !!trust?.trusted
  return <div className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${!last ? 'border-b border-dashed border-ink-fade/40' : ''}`}><div className="flex min-w-0 flex-1 items-start gap-3"><div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${trusted ? 'border-emerald-500/40 bg-emerald-50 text-emerald-700' : 'border-ink-fade/50 bg-paper-2 text-ink-fade'}`}><ShieldCheck className="h-4 w-4" /></div><div className="min-w-0"><div className="truncate font-mono text-xs text-ink" title={grant.path}>{grant.path}</div><div className="mt-1 text-xs text-ink-fade">{trusted ? t('localFiles.workspaceTrusted') : t('localFiles.workspaceTrustOff')}{trusted && trust?.config?.present === false ? ` · ${t('localFiles.workspaceConfigMissing')}` : ''}{trusted && trust?.config?.valid === false ? ` · ${trust.config.error?.message || t('localFiles.workspaceConfigInvalid')}` : ''}</div>{trust?.effective && <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(trust.effective).map(([name, enabled]) => <span key={name} className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${enabled ? 'border-emerald-500/30 text-emerald-700' : 'border-ink-fade/40 text-ink-fade line-through'}`}>{name}</span>)}</div>}</div></div><button type="button" onClick={() => controller.changeWorkspaceTrust(grant.path, !trusted)} disabled={controller.trustBusyPath === grant.path || !grant.available} className={`h-8 shrink-0 rounded-md border px-3 text-xs transition-colors disabled:opacity-50 ${trusted ? 'border-ink-fade/60 text-ink-soft hover:text-ink' : 'border-emerald-600/40 text-emerald-700 hover:bg-emerald-50'}`}>{controller.trustBusyPath === grant.path ? t('localFiles.workspaceTrustWorking') : trusted ? t('localFiles.workspaceUntrustAction') : t('localFiles.workspaceTrustAction')}</button></div>
}

export function ToolGateSection({ controller, t }) {
  return (
    <><SectionTitle eyebrow="TOOLS" title={t('permissionsDashboard.serverEnforced')} />{controller.toolError && <div className="mb-4 rounded-md border border-dashed border-ember/60 px-4 py-2.5 text-sm text-ember">{controller.toolError}</div>}<div className="mb-6 overflow-hidden rounded-md border border-ink/30">{GATEABLE_TOOLS.map((tool, index) => { const Icon = TOOL_ICONS[tool.id] || Terminal; const enabled = controller.isToolEnabled(tool.id); return <div key={tool.id} className={`grid grid-cols-[40px_1.4fr_1fr_80px] items-center gap-3 px-4 py-3 ${index < GATEABLE_TOOLS.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''}`} style={{ opacity: enabled ? 1 : 0.55 }}><div className="flex h-7 w-7 items-center justify-center rounded-md border border-ink-fade/60 bg-paper"><Icon className="h-3.5 w-3.5 text-ink-soft" /></div><div className="flex flex-col leading-tight"><span className="text-sm text-ink">{tool.name}</span><span className="font-mono text-[9px] tracking-wider text-ink-fade">{tool.id}</span></div><span className="text-sm text-ink-soft">{tool.scope}</span><PermSwitch on={enabled} onToggle={() => controller.toggleTool(tool.id)} label={`${enabled ? t('permissionsDashboard.disable') : t('permissionsDashboard.enable')} ${tool.name}`} /></div> })}</div></>
  )
}

export function BrowserPermissionSection({ controller, t }) {
  return (
    <><SectionTitle eyebrow="BROWSER" title={t('permissionsDashboard.title')} /><div className="overflow-hidden rounded-md border border-ink/30">{PERMISSION_ITEMS.map((item, index) => { const result = controller.results[item.id] || { state: 'unknown' }; const state = result.state || 'unknown'; const Icon = item.icon; const showRequest = item.requestable && ['prompt', 'denied'].includes(state); return <div key={item.id} className={`grid grid-cols-[40px_1.4fr_1fr_1fr_90px] items-center gap-3 px-4 py-3 ${index < PERMISSION_ITEMS.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''}`}><div className="flex h-7 w-7 items-center justify-center rounded-md border border-ink-fade/60 bg-paper"><Icon className="h-3.5 w-3.5 text-ink-soft" /></div><div className="flex flex-col leading-tight"><span className="text-sm text-ink">{t(`permissionsDashboard.${item.nameKey}`)}</span><span className="font-mono text-[9px] uppercase tracking-wider text-ink-fade">{item.id}</span></div><div className="flex flex-col leading-tight"><span className="text-sm text-ink-soft">{t(`permissionsDashboard.${item.scopeKey}`)}</span>{result.detail && <span className="font-mono text-[10px] text-ink-fade">{result.detail}</span>}</div><span className={`flex items-center gap-1.5 text-sm ${STATE_COLOR[state] || STATE_COLOR.unknown}`}><span className={`inline-block h-1.5 w-1.5 rounded-full ${STATE_DOT[state] || STATE_DOT.unknown}`} />{t(`permissionsDashboard.${STATE_KEY[state] || 'stateUnknown'}`)}</span><div>{showRequest && <button onClick={() => controller.requestPermission(item.id)} className="h-7 rounded-md border border-ink-fade/60 px-2.5 text-xs text-ink transition-colors hover:border-ember hover:text-ember">{t('permissionsDashboard.request')}</button>}</div></div> })}</div></>
  )
}

function SectionTitle({ eyebrow, title }) {
  return <div className="mb-2 flex items-baseline gap-2"><span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">{eyebrow}</span><span className="font-hand text-base text-ink-soft">{title}</span></div>
}

function PermSwitch({ on, onToggle, label }) {
  return <button onClick={onToggle} aria-label={label} className={`relative h-[22px] w-[38px] rounded-full border transition-all duration-200 ${on ? 'border-ember bg-ember' : 'border-ink-fade bg-paper'}`}><motion.div className={`absolute top-[2px] h-4 w-4 rounded-full ${on ? 'left-[18px] bg-paper' : 'left-[2px] bg-ink-fade'}`} layout transition={{ type: 'spring', stiffness: 500, damping: 30 }} /></button>
}
