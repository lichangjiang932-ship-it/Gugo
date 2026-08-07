import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSpeechRecognitionConstructor,
  mergeSpeechTranscript,
  readSpeechRecognitionEvent,
  resolveSpeechRecognitionLanguage,
} from '../../lib/voiceRecognition.js'
import { transcribeRecordedAudio } from '../../lib/mediaClient.js'

export default function useVoiceRecognition({ dispatch, input, lang, permissions, setInput, setMessage, t }) {
  const [voiceState, setVoiceState] = useState('idle')
  const recognitionRef = useRef(null)
  const recorderRef = useRef(null)

  useEffect(() => () => {
    recognitionRef.current?.abort?.()
    recorderRef.current?.stream?.getTracks?.().forEach((track) => track.stop())
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
      if (recorderRef.current?.recorder?.state === 'recording') {
        recorderRef.current.recorder.stop()
        setMessage(t('chatMessages.voiceStopped'))
        return
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') {
        setVoiceState('unsupported')
        setMessage(t('chatMessages.voiceUnsupported'))
        return
      }
      setVoiceState('requesting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const chunks = []
        const recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
        recorder.onstop = async () => {
          setVoiceState('requesting')
          try {
            const transcript = await transcribeRecordedAudio(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), {
              language: resolveSpeechRecognitionLanguage(lang),
            })
            setInput(mergeSpeechTranscript(input, transcript))
            setVoiceState('idle')
          } catch {
            setVoiceState('error')
            setMessage(t('chatMessages.voiceError'))
          } finally {
            stream.getTracks().forEach((track) => track.stop())
            recorderRef.current = null
          }
        }
        recorderRef.current = { recorder, stream }
        recorder.start()
        setVoiceState('listening')
      } catch (error) {
        const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
        setVoiceState(denied ? 'denied' : 'error')
        setMessage(t(denied ? 'chatMessages.voiceDenied' : 'chatMessages.voiceError'))
      }
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
