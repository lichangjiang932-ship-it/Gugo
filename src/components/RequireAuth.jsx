/**
 * 本机身份由后端静默准备；连接失败只提供重连，不引导本机用户登录。
 */

import { useState } from 'react'
import { Link, Navigate } from '../lib/router.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import ActionButton from './ui/ActionButton.jsx'
import { useAppContext } from '../store/AppContext'

export default function RequireAuth({ children }) {
  const { state, refreshAuth } = useAppContext()
  const { t } = useT()
  const [reconnecting, setReconnecting] = useState(false)
  if (!state.authReady) return null
  if (!state.isLoggedIn && state.authMode !== 'multi_user') {
    const reconnect = async () => {
      setReconnecting(true)
      try { await refreshAuth?.() } catch { /* the connection notice remains visible */ }
      finally { setReconnecting(false) }
    }
    return <main className="flex min-h-screen items-center justify-center bg-paper p-6">
      <section data-testid="local-service-unavailable" className="max-w-md space-y-4 text-sm text-ink">
        <h1 className="text-section font-semibold">{t('nav.localWorkspace')}</h1>
        <p role="status" className="text-ink-soft">{t('nav.localServiceReconnect')}</p>
        <div className="flex items-center gap-3">
          <ActionButton busy={reconnecting} onClick={reconnect} variant="primary">{t('nav.reconnectLocalService')}</ActionButton>
          <Link to="/chat" className="text-ink-soft underline">{t('nav.chat')}</Link>
        </div>
      </section>
    </main>
  }
  if (!state.isLoggedIn) return <Navigate to="/chat" replace />
  return children
}
