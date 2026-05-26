import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bell, CheckCheck, Dot, ExternalLink, Loader2, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAppContext } from '../store/AppContext.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from './Toast.jsx'
import { getAuthToken } from '../lib/accountClient.js'
import {
  getUnreadNotificationCount,
  listNotifications,
  markNotificationsRead,
  subscribeToNotifications,
} from '../lib/notificationClient.js'

function formatRelative(ts, lang) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return lang === 'en' ? 'now' : '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(ts).toLocaleDateString(lang)
}

function toastTypeForNotification(notification) {
  if (['success', 'error', 'warn'].includes(notification?.kind)) return notification.kind
  if (notification?.kind === 'job') {
    const status = notification.data?.status
    if (status === 'completed') return 'success'
    if (status === 'failed') return 'error'
    if (status === 'cancelled') return 'warn'
  }
  return null
}

export default function NotificationCenter() {
  const navigate = useNavigate()
  const panelRef = useRef(null)
  const { state } = useAppContext()
  const { t, lang } = useT()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const token = getAuthToken()
  const enabled = !!token && state.isLoggedIn

  const unreadIds = useMemo(
    () => notifications.filter((item) => !item.readAt).map((item) => item.id),
    [notifications],
  )

  const refresh = useCallback(async () => {
    if (!getAuthToken()) return
    setLoading(true)
    try {
      const [listPayload, countPayload] = await Promise.all([
        listNotifications({ limit: 20 }),
        getUnreadNotificationCount(),
      ])
      setNotifications(Array.isArray(listPayload.notifications) ? listPayload.notifications : [])
      setUnreadCount(Number(countPayload.count || 0))
    } catch {
      setNotifications([])
      setUnreadCount(0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setTimeout(() => {
      refresh()
    }, 0)
    const unsubscribe = subscribeToNotifications((notification) => {
      setNotifications((current) => [notification, ...current.filter((item) => item.id !== notification.id)].slice(0, 20))
      if (!notification.readAt) setUnreadCount((current) => current + 1)
      const type = toastTypeForNotification(notification)
      if (type) {
        toast[type]({
          title: notification.title,
          body: notification.body,
        })
      }
    })
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [enabled, refresh, toast, token])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const markOneRead = async (id) => {
    if (!id) return
    try {
      const payload = await markNotificationsRead({ ids: [id] })
      setNotifications((current) => current.map((item) => (
        item.id === id ? { ...item, readAt: item.readAt || Date.now() } : item
      )))
      setUnreadCount(Number(payload.unreadCount || 0))
    } catch {
      // Non-critical UI sync; next refresh will reconcile.
    }
  }

  const markAll = async () => {
    if (!unreadIds.length) return
    try {
      const payload = await markNotificationsRead({ all: true })
      const now = Date.now()
      setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt || now })))
      setUnreadCount(Number(payload.unreadCount || 0))
    } catch {
      // Non-critical UI sync; next refresh will reconcile.
    }
  }

  const openNotification = async (notification) => {
    if (!notification.readAt) await markOneRead(notification.id)
    if (notification.link) {
      navigate(notification.link)
      setOpen(false)
    }
  }

  if (!enabled) return null

  return (
    <div ref={panelRef} className="fixed top-4 right-4 z-30">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="relative w-10 h-10 rounded-md border border-ink/20 bg-paper/95 shadow-sm backdrop-blur inline-flex items-center justify-center text-ink-soft hover:text-ink hover:border-ember/60"
        aria-label={t('notifications.bellLabel')}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <section className="absolute right-0 mt-2 w-[min(380px,calc(100vw-2rem))] rounded-md border border-ink/20 bg-paper shadow-xl overflow-hidden">
          <header className="px-3 py-2.5 border-b border-dashed border-ink-fade/40 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t('notifications.title')}</h2>
              <p className="text-[11px] text-ink-fade">{t('notifications.unread', { count: unreadCount })}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={markAll}
                disabled={!unreadIds.length}
                className="h-7 px-2 rounded border border-ink/15 text-xs text-ink-soft hover:text-ink hover:border-ember/50 disabled:opacity-40 inline-flex items-center gap-1"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                {t('notifications.markAllRead')}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-7 h-7 rounded inline-flex items-center justify-center text-ink-fade hover:bg-ink/10 hover:text-ink"
                aria-label={t('common.cancel')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </header>

          <div className="max-h-[420px] overflow-y-auto">
            {loading ? (
              <div className="h-28 flex items-center justify-center text-ink-fade">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-fade">{t('notifications.empty')}</p>
            ) : (
              notifications.map((notification) => {
                const unread = !notification.readAt
                return (
                  <article key={notification.id} className="border-b border-ink/10 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => openNotification(notification)}
                      className="w-full text-left px-3 py-3 hover:bg-paper-2/70 flex gap-2"
                    >
                      <Dot className={`w-5 h-5 mt-0.5 shrink-0 ${unread ? 'text-red-600' : 'text-ink-ghost'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className={`text-sm leading-snug truncate ${unread ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
                            {notification.title}
                          </h3>
                          <span className="text-[10px] text-ink-fade shrink-0">{formatRelative(notification.createdAt, lang)}</span>
                        </div>
                        {notification.body && (
                          <p className="mt-1 text-xs text-ink-fade leading-relaxed line-clamp-2">{notification.body}</p>
                        )}
                        {notification.link && (
                          <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-ember">
                            <ExternalLink className="w-3 h-3" />
                            {t('notifications.open')}
                          </span>
                        )}
                      </div>
                    </button>
                    {unread && (
                      <div className="px-10 pb-2">
                        <button
                          type="button"
                          onClick={() => markOneRead(notification.id)}
                          className="text-[11px] text-ink-fade hover:text-ember"
                        >
                          {t('notifications.markRead')}
                        </button>
                      </div>
                    )}
                  </article>
                )
              })
            )}
          </div>
        </section>
      )}
    </div>
  )
}
