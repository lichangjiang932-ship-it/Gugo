import { RefreshCw } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import { useAppContext } from '../store/AppContext'
import {
  BrowserPermissionSection,
  CodeExecutionStatusSection,
  PermissionStats,
  ToolGateSection,
  WorkbenchPolicySection,
  WorkspaceOnboardingSection,
  WorkspaceTrustSection,
} from './permissions/PermissionSections.jsx'
import usePermissionsDashboard from './permissions/usePermissionsDashboard.js'

export default function PermissionsDashboard() {
  const { t } = useT()
  const { state: appState, dispatch } = useAppContext()
  const controller = usePermissionsDashboard(t)
  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      <LeftRail />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mb-6 flex items-end justify-between">
          <div><span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">PERMISSIONS</span><h1 className="mt-1.5 font-hand text-[28px] text-ink">{t('permissionsDashboard.title')}</h1><p className="mt-1 font-hand text-base text-ink-soft">{t('permissionsDashboard.subtitle')}</p></div>
          <button onClick={controller.runChecks} disabled={controller.checking} className="flex h-9 items-center gap-1.5 rounded-md border border-dashed border-ink-fade/60 px-4 font-hand text-sm text-ink-soft transition-colors hover:border-ink-fade disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${controller.checking ? 'animate-spin' : ''}`} />{controller.checking ? t('permissionsDashboard.checking') : t('permissionsDashboard.refresh')}</button>
        </div>
        <PermissionStats controller={controller} t={t} />
        <WorkspaceOnboardingSection key={controller.localFiles?.onboarding?.completedAt || (controller.localFiles ? 'loaded' : 'loading')} controller={controller} t={t} />
        <WorkbenchPolicySection appState={appState} dispatch={dispatch} t={t} />
        <CodeExecutionStatusSection controller={controller} t={t} />
        <WorkspaceTrustSection controller={controller} t={t} />
        <ToolGateSection controller={controller} t={t} />
        <BrowserPermissionSection controller={controller} t={t} />
      </div>
    </div>
  )
}
