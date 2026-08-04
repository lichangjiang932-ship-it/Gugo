import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSpeechRecognitionConstructor,
  mergeSpeechTranscript,
  readSpeechRecognitionEvent,
  resolveSpeechRecognitionLanguage,
} from '../../lib/voiceRecognition.js'

export default function useVoiceRecognition({ dispatch, input, lang, permissions, setInput, setMessage, t }) {
  const [voiceState, setVoiceState] = useState('idle')
  const recognitionRef = useRef(null)

  useEffect(() => () => {
    recognitionRef.current?.abort?.()
    recognitionRef.current = null
  }, [])

  const handleVoice = useCallback(async () => {
    if (voiceState === 'requesting') return
    if (voiceState === 'listening') {
      recognitionRef.current?.stop?.()
      setMessage(t('chatMessages.voiceStopped'))
      return
    }
    const SpeechRecognition = getSpeechRecognitionConstructor(window)
    if (!SpeechRecognition) {
      setVoiceState('unsupported')
      setMessage(t('chatMessages.voiceUnsupported'))
      return
    }

    setVoiceState('requesting')
    try {
      const recognition = new SpeechRecognition()
      recognition.lang = resolveSpeechRecognitionLanguage(lang)
      recognition.continuous = false
      recognition.interimResults = true
      const baseInput = input.trimEnd()
      let finalTranscript = ''
      let failed = false
      recognition.onstart = () => {
        const microphonePermission = permissions.find((permission) => permission.id === 'mic')
        if (!microphonePermission?.enabled) dispatch({ type: 'TOGGLE_PERM', payload: 'mic' })
        setVoiceState('listening')
      }
      recognition.onresult = (event) => {
        const next = readSpeechRecognitionEvent(event, finalTranscript)
        finalTranscript = next.committed
        setInput(mergeSpeechTranscript(baseInput, next.transcript))
      }
      recognition.onend = () => {
        if (recognitionRef.current === recognition) recognitionRef.current = null
        if (!failed) setVoiceState('idle')
      }
      recognition.onerror = (event) => {
        failed = true
        recognitionRef.current = null
        const error = event?.error || 'unknown'
        const status = error === 'not-allowed' || error === 'service-not-allowed' ? 'denied' : 'error'
        const messageKey = status === 'denied'
          ? 'chatMessages.voiceDenied'
          : error === 'no-speech'
            ? 'chatMessages.voiceNoSpeech'
            : error === 'network'
              ? 'chatMessages.voiceNetworkError'
              : 'chatMessages.voiceError'
        setVoiceState(status)
        setMessage(t(messageKey))
      }
      recognitionRef.current = recognition
      recognition.start()
    } catch (error) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
      setVoiceState(denied ? 'denied' : 'error')
      setMessage(t(denied ? 'chatMessages.voiceDenied' : 'chatMessages.voiceError'))
    }
  }, [dispatch, input, lang, permissions, setInput, setMessage, t, voiceState])

  return { handleVoice, voiceState }
}
