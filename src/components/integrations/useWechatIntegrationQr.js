import { useCallback, useEffect, useRef, useState } from 'react'
import { getWechatQrcodeApi, pollWechatQrcodeApi } from '../../lib/integrationsClient.js'
import { createPoller as createWechatQrPoller } from '../../lib/wechatQrPoller.js'

const IDLE_STATE = { phase: 'idle', secondsLeft: 0, expiresAt: 0, statusText: '', errorText: '' }

export function useWechatIntegrationQr({ form, setForm, setIntegrations, setTestMessage, t }) {
  const [wechatQr, setWechatQr] = useState(null)
  const [wechatState, setWechatState] = useState(IDLE_STATE)
  const pollerRef = useRef(null)
  const expiresAtRef = useRef(0)

  const stop = useCallback(() => {
    pollerRef.current?.stop()
    pollerRef.current = null
  }, [])

  const startPolling = useCallback((qr) => {
    if (!qr?.qrcodeId) return
    const poller = createWechatQrPoller({
      fetch: () => pollWechatQrcodeApi({
        qrcodeId: qr.qrcodeId,
        integrationId: form?.id || undefined,
        name: form?.name || 'WeChat Personal',
        defaultAgentId: form?.config?.defaultAgentId || '',
      }),
      intervalMs: 2000,
      maxAttempts: 60,
      maxFailures: 3,
      onUpdate: (event) => {
        if (event.type === 'status') {
          setWechatState((current) => ({ ...current, statusText: event.status || '', errorText: '' }))
          return
        }
        if (event.type === 'done') {
          if (event.status === 'confirmed' && event.data?.integration) {
            const next = event.data.integration
            setIntegrations((current) => current.some((item) => item.id === next.id)
              ? current.map((item) => item.id === next.id ? next : item)
              : [next, ...current])
            setForm(null)
            setWechatQr(null)
            setWechatState({ ...IDLE_STATE, phase: 'success' })
          } else if (event.status === 'expired') {
            setWechatState((current) => ({ ...current, phase: 'expired', errorText: t('wechat.qr.expired') }))
          } else {
            setWechatState((current) => ({ ...current, phase: 'error', errorText: event.data?.message || event.status }))
          }
          return
        }
        if (event.type === 'error') {
          const messages = { networkError: t('wechat.qr.networkError'), serverError: t('wechat.qr.serverError'), timeout: t('wechat.qr.timeout') }
          setWechatState((current) => ({ ...current, phase: event.kind === 'timeout' ? 'timeout' : 'error', errorText: event.kind === 'clientError' ? event.message || t('wechat.qr.serverError') : messages[event.kind] || event.message || '' }))
        }
      },
    })
    pollerRef.current = poller
    poller.start()
  }, [form, setForm, setIntegrations, t])

  const openWechatQr = useCallback(async () => {
    stop()
    setTestMessage('')
    setWechatQr(null)
    setWechatState({ ...IDLE_STATE, phase: 'loading' })
    let data
    try {
      data = await getWechatQrcodeApi()
    } catch (error) {
      const status = Number(error?.status) || 0
      const errorText = status >= 400 && status < 500 ? error?.message || t('wechat.qr.serverError') : status >= 500 ? t('wechat.qr.serverError') : t('wechat.qr.networkError')
      setWechatState({ ...IDLE_STATE, phase: 'error', errorText })
      return
    }
    setWechatQr(data)
    const expiresIn = Number(data?.expiresIn) > 0 ? Number(data.expiresIn) : 120
    const expiresAt = Date.now() + expiresIn * 1000
    expiresAtRef.current = expiresAt
    setWechatState({ ...IDLE_STATE, phase: 'ready', secondsLeft: expiresIn, expiresAt })
    startPolling(data)
  }, [setTestMessage, startPolling, stop, t])

  const resetWechatQr = useCallback(() => {
    stop()
    setWechatQr(null)
    setWechatState(IDLE_STATE)
  }, [stop])

  useEffect(() => {
    if (wechatState.phase !== 'ready') return undefined
    const tick = () => {
      const remaining = Math.max(0, Math.round((expiresAtRef.current - Date.now()) / 1000))
      setWechatState((current) => {
        if (current.phase !== 'ready') return current
        if (remaining <= 0) {
          stop()
          return { ...current, phase: 'expired', secondsLeft: 0, errorText: t('wechat.qr.expired') }
        }
        return { ...current, secondsLeft: remaining }
      })
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [stop, t, wechatState.phase])

  useEffect(() => stop, [stop])

  return { wechatQr, wechatState, openWechatQr, resetWechatQr }
}
