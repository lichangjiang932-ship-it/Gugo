import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendTerminalEntry,
  createTerminalTranscript,
  TERMINAL_LIMITS,
  TERMINAL_STREAM,
  trimTerminalEntries,
} from '../../src/lib/terminalTranscript.js'

const entry = (text, stream = TERMINAL_STREAM.STDOUT) => ({ stream, text })
const textOf = (transcript) => transcript.entries.map((item) => item.text)

test('entries keep their stream instead of being flattened into one blob', () => {
  let transcript = createTerminalTranscript()
  transcript = appendTerminalEntry(transcript, entry('npm test', TERMINAL_STREAM.COMMAND))
  transcript = appendTerminalEntry(transcript, entry('ok 1 - works'))
  transcript = appendTerminalEntry(transcript, entry('1 failing', TERMINAL_STREAM.STDERR))

  assert.deepEqual(transcript.entries.map((item) => item.stream), ['command', 'stdout', 'stderr'])
  // Each entry is addressable, which is what lets the panel render a failure
  // differently from ordinary output.
  assert.deepEqual(transcript.entries.map((item) => item.id), [1, 2, 3])
  assert.equal(transcript.dropped, 0)
})

test('a very long session keeps the first command and the newest output', () => {
  let transcript = createTerminalTranscript()
  transcript = appendTerminalEntry(transcript, entry('the first command', TERMINAL_STREAM.COMMAND))
  for (let index = 0; index < 500; index += 1) {
    transcript = appendTerminalEntry(transcript, entry(`output ${index}`))
  }

  assert.ok(transcript.entries.length <= TERMINAL_LIMITS.maxEntries, 'the transcript stays bounded')
  // What was asked and what just happened are the two things worth keeping.
  assert.equal(transcript.entries[0].text, 'the first command')
  assert.equal(transcript.entries.at(-1).text, 'output 499')
  assert.ok(transcript.dropped > 0, 'the omission is counted rather than hidden')
  assert.equal(
    transcript.entries.length + transcript.dropped,
    501,
  )
})

test('the character budget is enforced even when the entry count is not exceeded', () => {
  // Twenty entries of 10k characters each is only twenty entries, but 200k of text.
  const big = Array.from({ length: 20 }, (_value, index) => entry(`chunk-${index}-${'x'.repeat(10_000)}`))
  const { dropped, entries } = trimTerminalEntries(big)
  const total = entries.reduce((sum, item) => sum + item.text.length, 0)

  assert.ok(dropped > 0)
  assert.ok(total <= TERMINAL_LIMITS.maxChars, `kept ${total} characters`)
  // The newest entry keeps its tail: that is where a failure message is.
  assert.match(entries.at(-1).text, /x{100}$/u)
})

test('one enormous output is clipped to its tail rather than kept whole', () => {
  const huge = [entry('cmd', TERMINAL_STREAM.COMMAND), entry('y'.repeat(TERMINAL_LIMITS.maxChars * 2))]
  const { entries } = trimTerminalEntries(huge)
  const total = entries.reduce((sum, item) => sum + item.text.length, 0)

  assert.ok(total <= TERMINAL_LIMITS.maxChars)
  assert.equal(entries.length, 2, 'nothing was dropped outright; the last entry was clipped')
  assert.equal(entries[1].clipped, true)
  assert.match(entries[1].text, /y{50}$/u)
})

test('an empty or missing transcript is usable rather than throwing', () => {
  assert.deepEqual(createTerminalTranscript(), { entries: [], dropped: 0, nextId: 1 })
  const appended = appendTerminalEntry(null, entry('hello'))
  assert.deepEqual(textOf(appended), ['hello'])
})

test('Windows CRLF output is shown as plain lines without a trailing blank', () => {
  const transcript = appendTerminalEntry(createTerminalTranscript(), {
    stream: 'stdout', text: 'gugo-probe \r\nD:\\work\\app\r\n',
  })
  assert.equal(transcript.entries[0].text, 'gugo-probe \nD:\\work\\app')
})
