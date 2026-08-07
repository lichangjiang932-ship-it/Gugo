import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken, loginWithPassword, sendLoginCode, verifyLoginCode } from '../../lib/accountClient.js'
import { fetchPendingCount, subscribeToApprovalEvents } from '../../lib/approvalClient.js'
import { LOGIN_CODE_COUNTDOWN_SECONDS } from '../../lib/loginCountdown.js'
import { settingsPathAfterLogin } from '../../lib/settingsNavigation.js'

const EMPTY_LOGIN = { open: false, email: '', code: '', password: '', message: '', loading: false, mode: 'password', countdown: 0, target: null }

export default function useLeftRailController({ authMode, dispatch, location, navigate, t, toast }) {
  const [login, setLogin] = useState(EMPTY_LOGIN)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const accountMenuRef = useRef(null)
  const updateLogin = useCallback((patch) => setLogin((current) => ({ ...current, ...patch })), [])

  useEffect(() => {
    const onEscape = () => { setOpenMenuId(null); setAccountMenuOpen(false) }
    window.addEventListener('app:escape', onEscape)
    return () => window.removeEventListener('app:escape', onEscape)
  }, [])

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
    } catch (error) { updateLogin({ message: error.message }); toast.error({ title: t('toast.sendCodeFailed'), body: error.message }) }
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
    } catch (error) { updateLogin({ message: error.message }); toast.error({ title: t('toast.loginFailed'), body: error.message }) }
    finally { updateLogin({ loading: false }) }
  }

  return { accountMenuOpen, accountMenuRef, login, openMenuId, pendingApprovals, navigateItem, sendCode, setAccountMenuOpen, setOpenMenuId, updateLogin, verify }
}
