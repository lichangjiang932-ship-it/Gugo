import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  getSpeechRecognitionConstructor,
  mergeSpeechTranscript,
  readSpeechRecognitionEvent,
  resolveSpeechRecognitionLanguage,
} from '../src/lib/voiceRecognition.js'

test('voice recognition supports standard and Chromium constructors without a second media request', () => {
  class StandardRecognition {}
  class ChromiumRecognition {}
  assert.equal(getSpeechRecognitionConstructor({ SpeechRecognition: StandardRecognition, webkitSpeechRecognition: ChromiumRecognition }), StandardRecognition)
  assert.equal(getSpeechRecognitionConstructor({ webkitSpeechRecognition: ChromiumRecognition }), ChromiumRecognition)
  assert.equal(getSpeechRecognitionConstructor({}), null)

  const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.match(chatSource, /getSpeechRecognitionConstructor\(window\)/)
  assert.doesNotMatch(chatSource, /getUserMedia\(/)
})

test('voice recognition maps UI languages and combines final and interim speech', () => {
  assert.equal(resolveSpeechRecognitionLanguage('zh'), 'zh-CN')
  assert.equal(resolveSpeechRecognitionLanguage('zh-TW'), 'zh-TW')
  assert.equal(resolveSpeechRecognitionLanguage('en'), 'en-US')

  const first = readSpeechRecognitionEvent({
    resultIndex: 0,
    results: [
      { 0: { transcript: '你好' }, isFinal: true },
      { 0: { transcript: '世界' }, isFinal: false },
    ],
  })
  assert.deepEqual(first, { committed: '你好', interim: '世界', transcript: '你好世界' })

  const second = readSpeechRecognitionEvent({
    resultIndex: 1,
    results: [
      { 0: { transcript: '你好' }, isFinal: true },
      { 0: { transcript: '世界' }, isFinal: true },
    ],
  }, first.committed)
  assert.equal(second.transcript, '你好世界')
  assert.equal(mergeSpeechTranscript('帮我记录', second.transcript), '帮我记录 你好世界')
})
