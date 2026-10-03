import { useCallback, useRef } from 'react'
import { steerServerTurn } from '../../lib/turnClient.js'
import { getTurnRun } from './turnRunRegistry.js'

function normalizeText(value) {
  return String(value || '').trim()
}

export function mergeSteeringDraft(sentContent, currentDraft) {
  const sent = normalizeText(sentContent)
  const current = String(currentDraft || '').trim()
  if (!sent) return current
  if (!current || current === sent) return sent
  return `${sent}\n\n${current}`
}

/**
 * "No, and do this instead" (Claude Code): a refusal that carries a note sends
 * the note as steering first. The loop claims steering before its next model
 * request — the same round in which the model reads the refusal — so the two
 * arrive together. A refusal without a note, and every approval, goes straight
 * through.
 */
export function createRefusalWithFeedback({ resolveToolApproval, steerActiveTurn }) {
  return (decision) => {
    const feedback = decision?.approved === false ? normalizeText(decision.feedback) : ''
    if (!feedback) return resolveToolApproval(decision)
    void Promise.resolve(steerActiveTurn(feedback, { keepDraft: true }))
      .catch(() => false)
      .finally(() => resolveToolApproval({ approved: false }))
    return true
  }
}

export function resolveSteeringTarget({ sessionId, messages = [], run = null } = {}) {
  const normalizedSessionId = normalizeText(sessionId)
  if (!normalizedSessionId) return null
  const assistant = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => (
    message?.role === 'assistant'
      && message?.meta?.streaming === true
      && normalizeText(message?.meta?.serverTurnId)
  ))
  const turnId = normalizeText(assistant?.meta?.serverTurnId || run?.turnId)
  if (!turnId) return null
  return {
    sessionId: normalizedSessionId,
    turnId,
    assistantMessageId: normalizeText(assistant?.id) || `${turnId}:assistant`,
  }
}

export default function useTurnSteering({
  dispatch,
  inputRef,
  setInput,
  setWorkbenchMessage,
  stateRef,
  t,
}) {
  const pendingRef = useRef(false)
  const retryRef = useRef(null)

  return useCallback(async (rawContent, { keepDraft = false } = {}) => {
    const content = normalizeText(rawContent)
    if (!content || pendingRef.current) return false
    const state = stateRef.current
    const sessionId = normalizeText(state?.activeSessionId)
    const session = state?.sessions?.find((item) => item.id === sessionId)
    const target = resolveSteeringTarget({
      sessionId,
      messages: session?.messages,
      run: getTurnRun(sessionId),
    })
    if (!target) return false

    const retry = retryRef.current
    const clientRequestId = retry?.sessionId === sessionId
      && retry?.turnId === target.turnId
      && retry?.content === content
      ? retry.clientRequestId
      : (crypto.randomUUID?.() ?? `steer-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    retryRef.current = { ...target, content, clientRequestId }
    pendingRef.current = true
    // Feedback typed into an approval card is not the composer's draft; sending
    // it must leave whatever the reader was writing below untouched.
    if (!keepDraft) {
      inputRef.current = ''
      setInput('')
      dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId, text: '' } })
    }

    try {
      const steering = await steerServerTurn({
        sessionId,
        turnId: target.turnId,
        content,
        clientRequestId,
      })
      dispatch({
        type: 'INSERT_STEERING_MESSAGE',
        payload: {
          id: normalizeText(steering?.messageId) || `steer:${clientRequestId}`,
          sessionId,
          turnId: target.turnId,
          beforeMessageId: target.assistantMessageId,
          clientRequestId: normalizeText(steering?.clientRequestId) || clientRequestId,
          content: normalizeText(steering?.content) || content,
          createdAt: Number(steering?.createdAt) || Date.now(),
        },
      })
      retryRef.current = null
      setWorkbenchMessage(t('chatSteering.sent'))
      return true
    } catch {
      if (!keepDraft) {
        const restored = mergeSteeringDraft(content, inputRef.current)
        inputRef.current = restored
        setInput(restored)
        dispatch({ type: 'SET_SESSION_DRAFT', payload: { sessionId, text: restored } })
      }
      setWorkbenchMessage(t('chatSteering.failed'))
      return false
    } finally {
      pendingRef.current = false
    }
  }, [dispatch, inputRef, setInput, setWorkbenchMessage, stateRef, t])
}
