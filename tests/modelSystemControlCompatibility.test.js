import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpenAICompatibleRequest } from '../server/adapters/modelRequestBuilder.js'
import { buildCompaction, validateToolCallChain } from '../server/services/compactionService.js'

const messages = [
  { role: 'system', content: 'STATIC SAFETY' },
  { role: 'system', content: 'STATIC IDENTITY' },
  { role: 'user', content: 'Complete the fixture task.' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'fixture-read', type: 'function',
    function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' } }] },
  { role: 'tool', tool_call_id: 'fixture-read', content: '{"ok":true,"content":"fixture"}' },
  { role: 'system', content: [{ type: 'text', text: '[VERIFICATION REQUIRED] inspect the result now' }] },
  { role: 'assistant', content: 'The result still needs verification.' },
  { role: 'system', content: '[GOAL CHANGED] do not execute obsolete work' },
]

function request(baseUrl, profileOverrides) {
  return JSON.parse(buildOpenAICompatibleRequest({ config: { baseUrl, modelName: 'fixture', profileOverrides },
    env: {}, messages }).init.body)
}

test('LM Studio keeps late runtime guards in position without sending forbidden middle system roles', () => {
  const snapshot = structuredClone(messages)
  const body = request('http://127.0.0.1:1234/v1')
  assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'user'])
  assert.equal(body.messages[0].content, 'STATIC SAFETY\n\nSTATIC IDENTITY')
  assert.equal(body.messages[3].tool_call_id, 'fixture-read')
  assert.deepEqual(body.messages[4].content, messages[5].content)
  assert.equal(body.messages[6].content, messages[7].content)
  assert.deepEqual(messages, snapshot, 'durable system roles and tool pairing remain unchanged')
})

test('generic compatible providers preserve middle system roles unless the endpoint explicitly disallows them', () => {
  assert.equal(request('https://compatible.example.invalid/v1').messages[4].role, 'system')
  assert.equal(request('http://127.0.0.1:1234/v1', { supportsMidConversationSystem: true }).messages[4].role, 'system')
  assert.equal(request('https://compatible.example.invalid/v1', { supportsMidConversationSystem: false }).messages[4].role, 'user')
})

test('LM Studio receives a bounded host continuation when compaction leaves no user-role message', () => {
  const source = [messages[0], { role: 'user', content: 'Inspect fixture.txt; preserve all original constraints.' },
    { role: 'assistant', content: 'Inspection is in progress.' }, messages[3], messages[4]]
  const compacted = buildCompaction({ messages: source, keepMessages: 1, force: true })
  assert.equal(compacted.ok, true)
  assert.equal(compacted.outboundMessages.some((message) => message.role === 'user'), false)
  const snapshot = structuredClone(compacted.outboundMessages)
  const build = (baseUrl, profileOverrides) => JSON.parse(buildOpenAICompatibleRequest({
    config: { baseUrl, modelName: 'fixture', profileOverrides }, env: {}, messages: compacted.outboundMessages,
  }).init.body).messages
  const outbound = build('http://127.0.0.1:1234/v1')
  assert.equal(outbound[0].role, 'system')
  assert.equal(outbound[1].role, 'user')
  assert.match(outbound[1].content, /Runtime continuation/)
  assert.match(outbound[1].content, /not new authorization/)
  assert.ok(outbound[1].content.length < 240)
  assert.equal(validateToolCallChain(outbound).ok, true)
  assert.deepEqual(outbound.slice(2), build('https://compatible.example.invalid/v1').slice(1))
  assert.deepEqual(build('http://127.0.0.1:1234/v1', { requiresUserMessage: false }), build('https://compatible.example.invalid/v1'))
  assert.deepEqual(compacted.outboundMessages, snapshot, 'durable compaction/archive messages must not acquire a fictitious user turn')
})
