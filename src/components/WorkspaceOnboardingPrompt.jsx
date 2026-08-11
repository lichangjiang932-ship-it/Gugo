import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, ShieldAlert, X } from 'lucide-react'

import { useT } from '../i18n/I18nProvider.jsx'
import { getLocalFileAccessApi } from '../lib/localFileAccessClient.js'
import { useLocation, useNavigate } from '../lib/router.jsx'
import {
  clearWorkspaceOnboardingDismissal,
  readWorkspaceOnboardingDismissal,
  shouldAutoOpenWorkspaceOnboarding,
  workspaceOnboardingIdentity,
  writeWorkspaceOnboardingDismissal,
} from '../lib/workspaceOnboardingPrompt.js'
import { useAppContext } from '../store/AppContext.jsx'

function browserStorage() {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

export function WorkspaceOnboardingPromptController({
  authenticated,
  authMode = '',
  fetchStatus = getLocalFileAccessApi,
  navigate,
  pathname,
  storage = browserStorage(),
  t,
  user,
}) {
  const identity = workspaceOnboardingIdentity(user, authMode)
  const promptedIdentitiesRef = useRef(new Set())
  const [loadedStatus, setLoadedStatus] = useState({ identity: '', onboarding: null })
  const [open, setOpen] = useState(false)
  const onboarding = loadedStatus.identity === identity ? loadedStatus.onboarding : null

  useEffect(() => {
    if (!authenticated || !identity) return undefined

    let active = true
    const controller = new AbortController()
    Promise.resolve(fetchStatus({ signal: controller.signal })).then((result) => {
      if (!active) return
      const next = result?.onboarding || null
      setLoadedStatus({ identity, onboarding: next })
      if (!next) return
      if (next.complete === true) {
        clearWorkspaceOnboardingDismissal(storage, identity)
        promptedIdentitiesRef.current.delete(identity)
        setOpen(false)
        return
      }

      const dismissed = readWorkspaceOnboardingDismissal(storage, identity)
      if (dismissed || pathname === '/permissions') {
        promptedIdentitiesRef.current.add(identity)
        setOpen(false)
      }
      if (!promptedIdentitiesRef.current.has(identity) && shouldAutoOpenWorkspaceOnboarding({
        authenticated,
        complete: false,
        dismissed,
        pathname,
      })) {
        promptedIdentitiesRef.current.add(identity)
        setOpen(true)
      }
    }).catch((error) => {
      if (active && error?.name !== 'AbortError') setLoadedStatus({ identity, onboarding: null })
    })
    return () => { active = false; controller.abort() }
  }, [authenticated, fetchStatus, identity, pathname, storage])

  const defer = useCallback(() => {
    writeWorkspaceOnboardingDismissal(storage, identity)
    promptedIdentitiesRef.current.add(identity)
    setOpen(false)
  }, [identity, storage])
  const openGuide = useCallback(() => {
    promptedIdentitiesRef.current.add(identity)
    setOpen(false)
    navigate('/permissions?focus=onboarding')
  }, [identity, navigate])

  if (!authenticated || !onboarding || onboarding.complete || pathname === '/permissions') return null

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm" data-testid="workspace-onboarding-prompt-backdrop">
          <section role="dialog" aria-modal="true" aria-labelledby="workspace-onboarding-prompt-title" className="w-full max-w-lg overflow-hidden rounded-xl border border-ink/25 bg-paper shadow-2xl">
            <div className="flex items-start gap-3 border-b border-dashed border-ink-fade/40 px-5 py-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800"><FolderOpen className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-fade">{t('permissionsDashboard.onboardingPromptEyebrow')}</div>
                <h2 id="workspace-onboarding-prompt-title" className="mt-1 font-hand text-2xl text-ink">{t('permissionsDashboard.onboardingPromptTitle')}</h2>
              </div>
              <button type="button" onClick={defer} aria-label={t('permissionsDashboard.onboardingPromptCloseLabel')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper-2 hover:text-ink"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <p className="text-sm leading-6 text-ink-soft">{t('permissionsDashboard.onboardingPromptBody')}</p>
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-50/70 px-3 py-2.5 text-xs leading-5 text-amber-900">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('permissionsDashboard.onboardingPromptSafety')}</span>
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-dashed border-ink-fade/40 px-5 py-4 sm:flex-row sm:justify-end">
              <button type="button" onClick={defer} className="h-9 rounded-md border border-ink-fade/60 px-4 text-sm text-ink-soft transition-colors hover:bg-paper-2">{t('permissionsDashboard.onboardingPromptLater')}</button>
              <button type="button" onClick={openGuide} className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-ember px-4 text-sm text-paper transition-colors hover:bg-ember/90">{t('permissionsDashboard.onboardingPromptOpen')}<ArrowRight className="h-4 w-4" /></button>
            </div>
          </section>
        </div>
      )}
      {!open && (
        <button type="button" onClick={() => setOpen(true)} data-testid="workspace-onboarding-reminder" className="fixed bottom-4 right-4 z-40 flex max-w-[min(24rem,calc(100vw-2rem))] items-center gap-2 rounded-full border border-amber-500/35 bg-paper/95 px-3.5 py-2 text-left text-xs text-ink-soft shadow-lg backdrop-blur transition-colors hover:border-amber-500/60 hover:bg-amber-50">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700" />
          <span className="truncate">{t('permissionsDashboard.onboardingPromptReminder')}</span>
          <span className="shrink-0 font-medium text-ember">{t('permissionsDashboard.onboardingPromptReminderAction')}</span>
        </button>
      )}
    </>
  )
}

export default function WorkspaceOnboardingPrompt() {
  const { state } = useAppContext()
  const { t } = useT()
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <WorkspaceOnboardingPromptController
      authenticated={state.authReady && state.isLoggedIn}
      authMode={state.authMode}
      navigate={navigate}
      pathname={location.pathname}
      t={t}
      user={state.user}
    />
  )
}
