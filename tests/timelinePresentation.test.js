import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantTimelinePresentation, stableTimelineSegments } from '../src/pages/ChatSplit/chatMessages/messageRow/timelinePresentation.js'

test('only public text before a tool anchors an expanded chronological history', () => {
  for (const [text, calls, expected] of [
    ['Plain response', [], false],
    ['Final response', [{ id: 'old', name: 'read_file' }], false],
    ['Final response', [{ id: 'first', name: 'read_file', textOffset: 0 }], false],
    ['Opening. Final response', [{ id: 'next', name: 'read_file', textOffset: 9 }], true],
    ['Opening only', [{ id: 'last', name: 'read_file', textOffset: 12 }], true],
    ['  Final response', [{ id: 'space', name: 'read_file', textOffset: 2 }], false],
  ]) {
    const before = structuredClone(calls)
    const segments = stableTimelineSegments(text, calls)
    const result = assistantTimelinePresentation(segments)
    assert.equal(result.hasPublicNarration, expected)
    assert.equal(result.execution.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('') + result.answer, text)
    assert.deepEqual(calls, before)
  }
})

test('public text and tool identities survive growth, completion and a restored timeline', () => {
  const first = '**Inspect**\n\n'
  const next = '**Check**\n\n'
  const calls = [{ id: 'read', name: 'read_file', textOffset: first.length },
    { id: 'check', name: 'run_command', textOffset: first.length + next.length }]
  const live = stableTimelineSegments(first + next, calls)
  const final = stableTimelineSegments(first + next + '**Done**', calls)
  assert.deepEqual(final.slice(0, live.length).map((segment) => segment.key), live.map((segment) => segment.key))
  assert.deepEqual(final.filter((segment) => segment.kind === 'tools').map((segment) => segment.stepOffset), [0, 1])
  const projection = assistantTimelinePresentation(final)
  assert.equal(projection.answer, '**Done**')
  assert.equal(projection.hasPublicNarration, true)
  assert.equal(projection.execution.some((segment) => segment.text === '**Done**'), false)
  assert.deepEqual(assistantTimelinePresentation(structuredClone(final)), projection)
})

test('choice decoration is removed only after slicing the original public coordinate space', () => {
  const before = 'Before choice [[choice:a:Option A|b:Option B]]\n\n'
  const after = '**After tool**'
  const segments = stableTimelineSegments(before + after, [{ id: 'read-choice', name: 'read_file', textOffset: before.length }])
  assert.deepEqual(segments.map((segment) => segment.kind), ['text', 'tools', 'text'])
  assert.equal(segments[0].text, 'Before choice')
  assert.equal(segments[2].text, after)
  assert.equal(assistantTimelinePresentation(segments).answer, after)
})
