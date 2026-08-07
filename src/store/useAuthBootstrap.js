import { useCallback, useEffect, useRef } from 'react'
import { bootstrapAuthWithRetry } from '../lib/accountClient.js'

export default function useAuthBootstrap({ dispatch, hydrated, mountedRef }) {
  const requestRef = useRef(null)
  const generationRef = useRef(0)
  const refreshAuth = useCallback(async ({ signal, retryDelays } = {}) => {
    const generation = ++generationRef.current
    const request = bootstrapAuthWithRetry({ signal, retryDelays })
    requestRef.current = request
    try {
      const result = await request
      if (mountedRef.current && generation === generationRef.current) dispatch({ type: 'AUTH_BOOTSTRAP', payload: result })
      return result
    } catch (error) {
      if (signal?.aborted) return null
      if (mountedRef.current && generation === generationRef.current) {
        console.warn('[AppContext] auth bootstrap failed:', error?.message || error)
        dispatch({ type: 'AUTH_BOOTSTRAP_FAILED' })
      }
      return null
    } finally {
      if (requestRef.current === request) requestRef.current = null
    }
  }, [dispatch, mountedRef])

  useEffect(() => {
    if (!hydrated) return undefined
    const controller = new AbortController()
    void refreshAuth({ signal: controller.signal })
    const retryWhenOnline = () => void refreshAuth({ retryDelays: [0, 250, 750] })
    window.addEventListener('online', retryWhenOnline)
    return () => { controller.abort(); window.removeEventListener('online', retryWhenOnline) }
  }, [hydrated, refreshAuth])

  return refreshAuth
}
