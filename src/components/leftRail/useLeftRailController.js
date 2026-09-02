import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken, loginWithPassword, sendLoginCode, verifyLoginCode } from '../../lib/accountClient.js'
import { fetchPendingCount, subscribeToApprovalEvents } from '../../lib/approvalClient.js'
import { LOGIN_CODE_COUNTDOWN_SECONDS } from '../../lib/loginCountdown.js'
import { settingsPathAfterLogin } from '../../lib/settingsNavigation.js'

const EMPTY_LOGIN = { open: false, email: '', code: '', password: '', message: '', loading: false, mode: 'password', countdown: 0, target: null }

const LOGIN_ERROR_I18N_KEYS = Object.freeze({
  AUTH_EMAIL_INVALID: 'leftRailLogin.emailInvalid',
  AUTH_SEND_CODE_RATE_LIMITED: 'leftRailLogin.sendCodeRateLimited',
  AUTH_SEND_CODE_FAILED: 'leftRailLogin.sendCodeFailed',
  AUTH_CODE_INVALID_OR_EXPIRED: 'leftRailLogin.codeInvalidOrExpired',
  AUTH_CODE_ATTEMPTS_EXCEEDED: 'leftRailLogin.codeAttemptsExceeded',
  AUTH_CODE_INVALID: 'leftRailLogin.codeInvalid',
  AUTH_CODE_EXPIRED: 'leftRailLogin.codeExpired',
  AUTH_VERIFY_FAILED: 'leftRailLogin.verifyFailed',
  AUTH_CREDENTIALS_REQUIRED: 'leftRailLogin.credentialsRequired',
  AUTH_ACCOUNT_LOCKED: 'leftRailLogin.accountLocked',
  AUTH_INVALID_CREDENTIALS: 'leftRailLogin.invalidCredentials',
  AUTH_LOGIN_RATE_LIMITED: 'leftRailLogin.loginRateLimited',
  AUTH_LOGIN_FAILED: 'leftRailLogin.loginFailed',
})

export function localizeLoginError(error, t) {
  return t(LOGIN_ERROR_I18N_KEYS[String(error?.code || '')] || 'errors.unknown')
}

export default function useLeftRailController({ authMode, dispatch, location, navigate, t, toast }) {
  const [login, setLogin] = useState(EMPTY_LOGIN)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const accountMenuRef = useRef(null)
  const updateLogin = useCallback((patch) => setLogin((current) => ({ ...current, ...patch })), [])
  const closeSessionMenu = useCallback(() => setOpenMenuId(null), [])

  useEffect(() => {
    const onEscape = () => { closeSessionMenu(); setAccountMenuOpen(false) }
    window.addEventListener('app:escape', onEscape)
    return () => window.removeEventListener('app:escape', onEscape)
  }, [closeSessionMenu])

  useEffect(() => {
    if (!accountMenuOpen) return undefined
    const closeOutside = (event) => { if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) setAccountMenuOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [accountMenuOpen])

  useEffect(() => {
    const openLogin = (event) => {
      if (authMode === 'local') return
      updateLogin({ open: true, target: event.detail?.path || null, message: event.detail?.message || t('errors.loginRequired') })
    }
    window.addEventListener('auth:required', openLogin)
    return () => window.removeEventListener('auth:required', openLogin)
  }, [authMode, t, updateLogin])

  useEffect(() => {
    if (login.countdown <= 0) return undefined
    const timer = window.setInterval(() => setLogin((current) => ({ ...current, countdown: Math.max(0, current.countdown - 1) })), 1000)
    return () => window.clearInterval(timer)
  }, [login.countdown])

  useEffect(() => {
    let alive = true
    if (!getAuthToken()) { Promise.resolve().then(() => { if (alive) setPendingApprovals(0) }); return () => { alive = false } }
    const refresh = () => fetchPendingCount().then((count) => { if (alive) setPendingApprovals(count) }).catch(() => {})
    refresh()
    let close
    try { close = subscribeToApprovalEvents(refresh) } catch { /* SSE is optional. */ }
    return () => { alive = false; try { close?.() } catch { /* noop */ } }
  }, [location.pathname])

  const navigateItem = (item) => {
    closeSessionMenu()
    setAccountMenuOpen(false)
    if (item.requiresLogin && !getAuthToken() && authMode !== 'local') { updateLogin({ open: true, target: item.path, message: t('errors.loginRequired') }); return }
    navigate(item.path)
  }

  const sendCode = async (event) => {
    event.preventDefault()
    if (login.countdown > 0) return
    updateLogin({ loading: true, message: '' })
    try {
      const result = await sendLoginCode(login.email)
      updateLogin({ countdown: LOGIN_CODE_COUNTDOWN_SECONDS, message: result.devCode ? t('leftRailLogin.devCode', { code: result.devCode }) : t('leftRailLogin.codeSent') })
    } catch (error) {
      const message = localizeLoginError(error, t)
      updateLogin({ message })
      toast.error({ title: t('toast.sendCodeFailed'), body: message })
    }
    finally { updateLogin({ loading: false }) }
  }

  const verify = async (event) => {
    event.preventDefault(); updateLogin({ loading: true, message: '' })
    try {
      const data = login.mode === 'password' ? await loginWithPassword({ email: login.email, password: login.password }) : await verifyLoginCode({ email: login.email, code: login.code })
      dispatch({ type: 'LOGIN', payload: { name: data.user.email.split('@')[0], email: data.user.email, avatar: null } })
      const defaultPath = settingsPathAfterLogin(data.user)
      navigate(data.user.hasPassword === false ? defaultPath : (login.target || defaultPath))
      setLogin(EMPTY_LOGIN)
    } catch (error) {
      const message = localizeLoginError(error, t)
      updateLogin({ message })
      toast.error({ title: t('toast.loginFailed'), body: message })
    }
    finally { updateLogin({ loading: false }) }
  }

  return { accountMenuOpen, accountMenuRef, closeSessionMenu, login, openMenuId, pendingApprovals, navigateItem, sendCode, setAccountMenuOpen, setOpenMenuId, updateLogin, verify }
}
