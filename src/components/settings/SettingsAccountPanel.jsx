import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAccount,
  getAuthToken,
  loginWithPassword,
  logoutAccount,
  removeAccountPassword,
  sendLoginCode,
  setAccountPassword,
  setAuthToken,
  verifyLoginCode,
} from '../../lib/accountClient.js'
import {
  LOGIN_CODE_COUNTDOWN_SECONDS,
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../../lib/loginCountdown.js'
import { shouldPromptPasswordSetup } from '../../lib/settingsNavigation.js'

function Group({ title, children }) {
  return (
    <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3">
      <h3 className="font-hand text-lg text-ink">{title}</h3>
      {children}
    </div>
  )
}

export default function SettingsAccountPanel({ authMode = 'multi_user', dispatch, search, t }) {
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginMode, setLoginMode] = useState('code')
  const [account, setAccount] = useState(null)
  const [accountMessage, setAccountMessage] = useState('')
  const [accountLoading, setAccountLoading] = useState(false)
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdConfirm, setPwdConfirm] = useState('')
  const [pwdLoading, setPwdLoading] = useState(false)
  const [pwdMessage, setPwdMessage] = useState('')
  const [loginCodeCountdown, setLoginCodeCountdown] = useState(0)
  const promptedSearchRef = useRef(null)

  const applyAccount = useCallback((data) => {
    setAccount(data)
    dispatch({
      type: 'LOGIN',
      payload: {
        name: data.user.email.split('@')[0],
        email: data.user.email,
        avatar: '本',
      },
    })
  }, [dispatch])

  const refreshAccount = useCallback(async () => {
    setAccountLoading(true)
    try {
      applyAccount(await getAccount())
    } catch (error) {
      setAccount(null)
      setAccountMessage(error.message)
      if (/登录/.test(error.message)) setAuthToken('')
    } finally {
      setAccountLoading(false)
    }
  }, [applyAccount])

  useEffect(() => {
    if (!getAuthToken()) return
    Promise.resolve().then(refreshAccount)
  }, [refreshAccount])

  useEffect(() => {
    if (!account?.user || !shouldPromptPasswordSetup(search, account.user) || promptedSearchRef.current === search) return
    promptedSearchRef.current = search
    setPwdMessage('请设置一个登录密码，下次可以直接用邮箱和密码登录。')
  }, [account?.user, search])

  useEffect(() => {
    if (loginCodeCountdown <= 0) return undefined
    const timer = window.setInterval(() => setLoginCodeCountdown((current) => Math.max(0, current - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [loginCodeCountdown])

  const handleSendCode = async (event) => {
    event.preventDefault()
    setAccountLoading(true)
    setAccountMessage('')
    try {
      const result = await sendLoginCode(loginEmail)
      setLoginCodeCountdown(LOGIN_CODE_COUNTDOWN_SECONDS)
      setAccountMessage(result.devCode ? `验证码已生成：${result.devCode}` : '验证码已发送，请检查邮箱。')
    } catch (error) {
      setAccountMessage(error.message)
    } finally {
      setAccountLoading(false)
    }
  }

  const handleVerify = async (event) => {
    event.preventDefault()
    setAccountLoading(true)
    setAccountMessage('')
    try {
      const data = loginMode === 'password'
        ? await loginWithPassword({ email: loginEmail, password: loginPassword })
        : await verifyLoginCode({ email: loginEmail, code: loginCode })
      applyAccount(data)
      setLoginPassword('')
      setLoginCode('')
      setAccountMessage('登录成功。')
    } catch (error) {
      setAccountMessage(error.message)
    } finally {
      setAccountLoading(false)
    }
  }

  const handleSetPassword = async (event) => {
    event.preventDefault()
    setPwdMessage('')
    if (pwdNew !== pwdConfirm) {
      setPwdMessage('两次输入的新密码不一致')
      return
    }
    setPwdLoading(true)
    try {
      const result = await setAccountPassword({ currentPassword: pwdCurrent, newPassword: pwdNew })
      setAccount((previous) => previous ? { ...previous, user: { ...previous.user, ...result.user } } : previous)
      setPwdCurrent('')
      setPwdNew('')
      setPwdConfirm('')
      setPwdMessage('密码已保存。')
    } catch (error) {
      setPwdMessage(error.message)
    } finally {
      setPwdLoading(false)
    }
  }

  const handleRemovePassword = async () => {
    if (!window.confirm('确定移除密码？以后只能用邮箱验证码登录。')) return
    setPwdMessage('')
    setPwdLoading(true)
    try {
      const result = await removeAccountPassword({ currentPassword: pwdCurrent })
      setAccount((previous) => previous ? { ...previous, user: { ...previous.user, ...result.user } } : previous)
      setPwdCurrent('')
      setPwdNew('')
      setPwdConfirm('')
      setPwdMessage('密码已移除。')
    } catch (error) {
      setPwdMessage(error.message)
    } finally {
      setPwdLoading(false)
    }
  }

  const handleLogout = async () => {
    try {
      await logoutAccount()
    } catch {
      setAuthToken('')
    }
    setAccount(null)
    dispatch({ type: 'LOGOUT' })
    setAccountMessage('已退出登录。')
  }

  if (authMode === 'local') {
    return (
      <section className="flex flex-col gap-5 animate-float-up">
        <div>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">LOCAL MODE</span>
          <h1 className="font-hand text-[28px] text-ink mt-1.5">{t('settings.account')}</h1>
          <p className="text-sm text-ink-soft mt-1">{t('settings.localAuthDescription')}</p>
        </div>
        <Group title={t('settings.localAuthTitle')}>
          <p className="text-sm text-ink-soft">{t('settings.localAuthHint')}</p>
          <p className="text-xs text-ink-fade"><code>AUTH_MODE=multi_user</code></p>
        </Group>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-5 animate-float-up">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">LOCAL ACCOUNT & SECURITY</span>
        <h1 className="font-hand text-[28px] text-ink mt-1.5">账户</h1>
        <p className="text-sm text-ink-soft mt-1">使用本地账户保护个人配置、会话和工作区访问。</p>
      </div>

      {account?.user ? (
        <>
          <div className="p-4 border border-ink/30 rounded-md flex items-center justify-between gap-4">
            <div>
              <div className="text-base text-ink">{account.user.email}</div>
              <div className="mt-1 text-sm text-ink-fade">本地账户 · 已登录</div>
            </div>
            <button onClick={handleLogout} className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md text-sm text-ink-soft hover:border-ink-fade">退出</button>
          </div>

          <Group title="登录密码">
            <p className="text-sm text-ink-soft mb-3">{account.user.hasPassword ? '已设置密码，可直接用邮箱和密码登录。' : '设置密码后可直接登录，邮箱验证码仍可用于找回密码。'}</p>
            <form onSubmit={handleSetPassword} className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {account.user.hasPassword ? <label className="flex flex-col gap-1 md:col-span-2"><span className="text-xs text-ink-fade">当前密码</span><input type="password" autoComplete="current-password" value={pwdCurrent} onChange={(event) => setPwdCurrent(event.target.value)} className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label> : null}
              <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">新密码（8 位以上，含字母和数字）</span><input type="password" autoComplete="new-password" value={pwdNew} onChange={(event) => setPwdNew(event.target.value)} className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">确认新密码</span><input type="password" autoComplete="new-password" value={pwdConfirm} onChange={(event) => setPwdConfirm(event.target.value)} className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label>
              <div className="md:col-span-2 flex gap-2">
                <button type="submit" disabled={pwdLoading || !pwdNew || !pwdConfirm || (account.user.hasPassword && !pwdCurrent)} className="h-9 px-4 bg-ember text-paper rounded-md text-sm hover:bg-ember/90 transition-colors disabled:opacity-50">{account.user.hasPassword ? '修改密码' : '设置密码'}</button>
                {account.user.hasPassword ? <button type="button" disabled={pwdLoading || !pwdCurrent} onClick={handleRemovePassword} className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md text-sm text-ink-soft hover:border-ink-fade disabled:opacity-50">移除密码</button> : null}
              </div>
              {pwdMessage && <div className="md:col-span-2 p-2 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{pwdMessage}</div>}
            </form>
          </Group>

        </>
      ) : (
        <div className="p-4 border border-ink/30 rounded-md flex flex-col gap-3 max-w-xl">
          <div className="flex gap-2">
            <button type="button" onClick={() => { setLoginMode('code'); setAccountMessage('') }} className={`h-9 px-4 rounded-md text-sm border transition-colors ${loginMode === 'code' ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}>{t('settings.loginWithCode')}</button>
            <button type="button" onClick={() => { setLoginMode('password'); setAccountMessage('') }} className={`h-9 px-4 rounded-md text-sm border transition-colors ${loginMode === 'password' ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}>{t('settings.loginWithPassword')}</button>
          </div>
          {loginMode === 'password' ? (
            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">邮箱</span><input value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="you@example.com" className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label>
              <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">{t('settings.loginPassword')}</span><input type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label>
              <button disabled={accountLoading || !loginEmail.trim() || !loginPassword.trim()} className="h-9 px-4 bg-ember text-paper rounded-md text-sm hover:bg-ember/90 transition-colors self-start disabled:opacity-50">{t('settings.loginSubmit')}</button>
            </form>
          ) : (
            <>
              <form onSubmit={handleSendCode} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">邮箱</span><input value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="you@example.com" className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label>
                <button disabled={shouldDisableLoginCodeButton({ accountLoading, loginEmail, countdown: loginCodeCountdown })} className="h-9 px-4 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft transition-colors self-start disabled:opacity-50">{formatLoginCodeCountdownLabel(loginCodeCountdown)}</button>
              </form>
              <form onSubmit={handleVerify} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">验证码</span><input value={loginCode} onChange={(event) => setLoginCode(event.target.value)} placeholder="6 位数字" className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink" /></label>
                <button disabled={accountLoading || !loginEmail.trim() || !loginCode.trim()} className="h-9 px-4 bg-ember text-paper rounded-md text-sm hover:bg-ember/90 transition-colors self-start disabled:opacity-50">登录</button>
              </form>
            </>
          )}
        </div>
      )}
      {accountMessage && <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">{accountMessage}</div>}
    </section>
  )
}
