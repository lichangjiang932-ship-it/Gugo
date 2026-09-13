import { useCallback, useRef, useState } from 'react'
import { forkSessionRemote } from '../../lib/sessionClient.js'

export default function useChatSessionBranches({
  activeSessionId,
  dispatch,
  isGenerating,
  navigate,
  stateRef,
  t,
  toast,
}) {
  const [forkingMessageId, setForkingMessageId] = useState('')
  const forkingMessageIdRef = useRef('')

  const handleForkMessage = useCallback(async (message) => {
    const sourceSessionId = String(activeSessionId || '').trim()
    const throughMessageId = String(message?.id || '').trim()
    if (!sourceSessionId
      || !['user', 'assistant'].includes(message?.role)
      || !throughMessageId
      || isGenerating
      || forkingMessageIdRef.current) return
    forkingMessageIdRef.current = throughMessageId
    setForkingMessageId(throughMessageId)
    try {
      const result = await forkSessionRemote(sourceSessionId, { throughMessageId })
      if (!result?.session?.id) throw new Error(t('nav.forkFailed'))
      dispatch({ type: 'ADD_SERVER_FORK', payload: { session: result.session } })
      dispatch({ type: 'SWITCH_SESSION', payload: result.session.id })
      navigate('/chat')
    } catch (error) {
      toast.error({
        title: t('nav.forkFailed'),
        body: error?.code === 'SESSION_ACTIVE' ? t('nav.forkActive') : error.message,
      })
    } finally {
      forkingMessageIdRef.current = ''
      setForkingMessageId('')
    }
  }, [activeSessionId, dispatch, isGenerating, navigate, t, toast])

  const handleOpenSessionBranch = useCallback((session) => {
    const sessionId = String(session?.id || '').trim()
    if (!sessionId) return
    if (!stateRef.current.sessions.some((candidate) => candidate.id === sessionId)) {
      dispatch({ type: 'ADD_SERVER_FORK', payload: { session } })
    }
    dispatch({ type: 'SWITCH_SESSION', payload: sessionId })
    navigate('/chat')
  }, [dispatch, navigate, stateRef])

  return { forkingMessageId, handleForkMessage, handleOpenSessionBranch }
}
