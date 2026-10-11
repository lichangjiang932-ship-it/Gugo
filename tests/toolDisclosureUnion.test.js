import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolsLoop, SERVER_TOOL_SPECS } from '../server/services/jobTools.js'
import { readSessionToolDisclosures } from '../server/services/sessionToolDisclosureStore.js'
import { issueTestSession } from './helpers/testAuth.js'

const DOCX_PROMPT = '帮我做一份 Word 文档'
const PPTX_PROMPT = '做一份 PPT'

let turnSequence = 0

async function runTurn({ userId, sessionId, prompt }) {
  turnSequence += 1
  const turnId = `disclosure-turn-${turnSequence}`
  let visible = null
  await runToolsLoop({
    job: { id: turnId, userId, sessionId, origin: 'chat', prompt, userPrompt: prompt },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    fallbackToolSpecs: SERVER_TOOL_SPECS,
    maxIters: 2,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      visible ??= tools.map((spec) => spec?.function?.name)
      return { content: '好的', toolCalls: [], finishReason: 'stop' }
    },
    executeTool: async () => {
      throw new Error('disclosure fixtures must never execute a tool')
    },
  })
  assert.ok(visible, 'the model must be offered a tool set')
  return visible
}

// The disclosed set only grows, so the prefix stops being rewritten when the
// selection swings back — but artifact generators are exempt. `selectToolSpecs`
// narrows them to the one format this turn asked for, and that list is the
// execution allow-list: `validateToolCall` rejects any call outside it with
// `unknown_tool`. Re-offering a generator from an earlier turn would therefore
// make it runnable again, which is the 2026-07-31 incident this gating exists to
// prevent.
test('artifact generators stay turn-scoped while other disclosed tools accumulate', async () => {
  const { userId } = issueTestSession({ email: 'tool-disclosure-union@example.com' })
  const sessionId = `disclosure-union-${process.pid}-${Date.now()}`

  const firstTurn = await runTurn({ userId, sessionId, prompt: DOCX_PROMPT })
  assert.ok(firstTurn.includes('create_docx'), 'this turn offers the generator it asked for')
  const afterDocx = readSessionToolDisclosures({ userId, sessionId })
  assert.ok(afterDocx.length > 0, 'the turn still discloses the tools it selected')
  assert.equal(
    afterDocx.includes('create_docx'),
    false,
    'a generator must never be carried into a later turn',
  )

  const secondTurn = await runTurn({ userId, sessionId, prompt: PPTX_PROMPT })
  assert.ok(secondTurn.includes('create_pptx'), 'the later turn offers its own generator')
  assert.equal(secondTurn.includes('create_docx'), false, 'the earlier generator must not reappear')
  assert.equal(secondTurn.includes('generate_image'), false)

  const afterPptx = readSessionToolDisclosures({ userId, sessionId })
  assert.equal(afterPptx.includes('create_pptx'), false)
  for (const name of afterDocx) {
    assert.ok(afterPptx.includes(name), `${name} must survive the later turn`)
  }
})

test('a turn with no session scope leaves disclosure state untouched', async () => {
  const { userId } = issueTestSession({ email: 'tool-disclosure-scopeless@example.com' })
  await runTurn({ userId, sessionId: null, prompt: DOCX_PROMPT })
  assert.deepEqual(readSessionToolDisclosures({ userId, sessionId: null }), [])
})
