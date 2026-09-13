import assert from 'node:assert/strict'
import test from 'node:test'
import { ASSISTANT_COMMUNICATION_POLICY, withAssistantCommunicationPolicy } from '../shared/assistantCommunicationPolicy.js'
import { buildCitationPrompt } from '../server/services/jobPromptBlocks.js'

test('public communication guidance is stable, inserted once, and preserves conversation ownership', () => {
  const safety = Object.freeze({ role: 'system', content: 'Keep every authorization boundary.' })
  const user = Object.freeze({ role: 'user', content: 'Make the requested file.' })
  const original = Object.freeze([safety, user])
  const once = withAssistantCommunicationPolicy(original)
  assert.equal(once[0], safety)
  assert.equal(once[1].content, ASSISTANT_COMMUNICATION_POLICY)
  assert.equal(once[2], user)
  assert.deepEqual(original, [safety, user])
  assert.deepEqual(withAssistantCommunicationPolicy(once), once)
})

test('only exact host duplicates are removed, never quotations or unrelated safety records', () => {
  const quoted = { role: 'user', content: ASSISTANT_COMMUNICATION_POLICY }
  const independent = { role: 'system', content: `${ASSISTANT_COMMUNICATION_POLICY}\nAdditional safety restrictions.` }
  const host = { role: 'system', content: ASSISTANT_COMMUNICATION_POLICY }
  const once = withAssistantCommunicationPolicy([host, independent, quoted, { ...host }])
  assert.deepEqual(once, [host, independent, quoted])
})

test('guidance asks for public facts and verified links rather than private reasoning or invented progress', () => {
  assert.match(ASSISTANT_COMMUNICATION_POLICY, /observable progress/)
  assert.match(ASSISTANT_COMMUNICATION_POLICY, /not private deliberation/)
  assert.match(ASSISTANT_COMMUNICATION_POLICY, /Never invent progress percentages/)
  assert.match(ASSISTANT_COMMUNICATION_POLICY, /exact verified URL or absolute path/)
  assert.match(ASSISTANT_COMMUNICATION_POLICY, /Do not narrate every tool call/)
  assert.match(buildCitationPrompt(), /工具验证并返回的准确 URL 或绝对路径/)
  assert.doesNotMatch(buildCitationPrompt(), /\[文件名\]\(相对路径\)/)
})
