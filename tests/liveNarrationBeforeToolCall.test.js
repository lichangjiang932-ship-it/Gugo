import test from 'node:test'
import assert from 'node:assert/strict'
import { runToolLoop } from '../server/services/loop/index.js'

// The finished trace reads "checking the sources, then building the deck" before
// each tool call, but while the turn ran none of that reached the screen: a
// response that may call a mutating tool was withheld whole, so the reader saw
// only "waiting for the model…" for over a minute. Narration that precedes a
// tool call is not an answer; it is published the moment the call starts.

const writeSpec = { type: 'function', function: { name: 'write_file', description: 'Write a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }

test('narration before a tool call reaches the live view before the call runs', async () => {
  const events = []
  let modelCalls = 0
  await runToolLoop({
    job: { id: 'narration-live', userId: 'narration-user', origin: 'chat', prompt: 'Write notes.txt.' },
    step: { id: 'narration-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write notes.txt.' }],
    toolSpecs: [writeSpec],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture' }),
    onModelDelta: async ({ text }) => { events.push(`delta:${text}`) },
    runModel: async ({ onTextDelta, onToolCallProgress }) => {
      modelCalls += 1
      if (modelCalls > 1) return { content: 'Done.', toolCalls: [] }
      await onTextDelta?.('Checking the folder first, ')
      await onTextDelta?.('then writing the file.')
      events.push('model:tool-arguments')
      await onToolCallProgress?.({ toolCallId: 'call-1', toolName: 'write_file', toolArgumentsChars: 40 })
      return { content: 'Checking the folder first, then writing the file.', toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes.txt","content":"x"}' } },
      ] }
    },
    executeTool: async () => { events.push('tool:ran'); return { ok: true, path: 'notes.txt', changedPaths: ['notes.txt'] } },
  })
  const firstDelta = events.findIndex((entry) => entry.startsWith('delta:Checking'))
  assert.ok(firstDelta >= 0, events.join(' | '))
  assert.ok(firstDelta < events.indexOf('tool:ran'), 'the narration is on screen before the tool runs')
  assert.ok(firstDelta > events.indexOf('model:tool-arguments'), 'and only once the model has started a call')
  assert.equal(events.filter((entry) => entry === 'delta:Checking the folder first, ').length, 1, 'published once')
})

test('a reply with no tool call is still held until it is accepted as the answer', async () => {
  const live = []
  await runToolLoop({
    job: { id: 'narration-held', userId: 'narration-user', origin: 'chat', prompt: 'Write notes.txt.' },
    step: { id: 'narration-held-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write notes.txt.' }],
    toolSpecs: [writeSpec],
    maxIters: 2,
    enableToolHooks: false,
    onModelDelta: async ({ text }) => { live.push(text) },
    runModel: async ({ onTextDelta }) => {
      await onTextDelta?.('All done!')
      return { content: 'All done!', toolCalls: [] }
    },
  })
  assert.equal(live.includes('All done!') && live.indexOf('All done!') !== live.lastIndexOf('All done!'), false, 'never doubled')
})

test('narration that pastes source code is still kept off the screen', async () => {
  const live = []
  let modelCalls = 0
  await runToolLoop({
    job: { id: 'narration-source', userId: 'narration-user', origin: 'chat', prompt: 'Write notes.txt.' },
    step: { id: 'narration-source-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write notes.txt.' }],
    toolSpecs: [writeSpec],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture' }),
    onModelDelta: async ({ text }) => { live.push(text) },
    runModel: async ({ onTextDelta, onToolCallProgress }) => {
      modelCalls += 1
      if (modelCalls > 1) return { content: 'Done.', toolCalls: [] }
      const pasted = 'Save this as notes.py:\n```python\nprint("x")\n```\n'
      await onTextDelta?.(pasted)
      await onToolCallProgress?.({ toolCallId: 'call-1', toolName: 'write_file', toolArgumentsChars: 40 })
      return { content: pasted, toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"notes.txt","content":"x"}' } },
      ] }
    },
    executeTool: async () => ({ ok: true, path: 'notes.txt', changedPaths: ['notes.txt'] }),
  })
  assert.equal(live.some((text) => text.includes('```python')), false, live.join(' | '))
})
