import { normalizeUiLanguage } from '../i18n/translations.js'

export function getSpeechRecognitionConstructor(scope = globalThis) {
  return scope?.SpeechRecognition || scope?.webkitSpeechRecognition || null
}

export function resolveSpeechRecognitionLanguage(lang) {
  return ({
    zh: 'zh-CN',
    en: 'en-US',
  })[normalizeUiLanguage(lang)]
}

export function readSpeechRecognitionEvent(event, committed = '') {
  let nextCommitted = String(committed || '')
  let interim = ''
  const results = event?.results || []
  const start = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0

  for (let index = start; index < results.length; index += 1) {
    const transcript = String(results[index]?.[0]?.transcript || '')
    if (results[index]?.isFinal) nextCommitted += transcript
    else interim += transcript
  }

  return {
    committed: nextCommitted,
    interim,
    transcript: `${nextCommitted}${interim}`,
  }
}

export function mergeSpeechTranscript(base, transcript) {
  const prefix = String(base || '').trimEnd()
  const spoken = String(transcript || '').trim()
  if (!spoken) return prefix
  return `${prefix}${prefix ? ' ' : ''}${spoken}`
}
