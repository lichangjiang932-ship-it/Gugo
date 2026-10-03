import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb } from '../server/db.js'
import { createLoopContext } from '../server/services/loop/context.js'
import { executePreparedToolsLoop, prepareToolsLoopRuntime, usePreparedToolsLoopRuntime } from '../server/services/loop/runtime.js'
import { ASSISTANT_COMMUNICATION_POLICY } from '../shared/assistantCommunicationPolicy.js'

test.after(() => closeDb())

for (const origin of ['chat', 'cli', 'job']) {
  test(`${origin} sends stable public progress and verified-link guidance to the actual model boundary`, async () => {
    const prompt = 'Explain the available output formats without creating files.'
    const messages = [{ role: 'user', content: prompt }]
    const original = structuredClone(messages)
    const requests = []
    const context = createLoopContext({
      job: { id: `communication-policy-${origin}`, userId: null, origin, prompt, userPrompt: prompt },
      step: { id: 'communication-step', kind: 'chat' },
      messages, intentMode: 'answer', toolSpecs: [], fallbackToolSpecs: [],
      maxIters: 1, enableToolHooks: false, semanticSummary: false,
      runModel: async ({ messages: outbound }) => {
        requests.push(structuredClone(outbound))
        return { content: 'The formats depend on the installed tools.', toolCalls: [], finishReason: 'stop' }
      },
      executeTool: async () => { throw new Error('An explanatory answer must not execute tools') },
    })
    const prepared = await prepareToolsLoopRuntime(context)
    const matching = (values) => values.filter((message) => message.role === 'system'
      && message.content === ASSISTANT_COMMUNICATION_POLICY)
    assert.equal(usePreparedToolsLoopRuntime(prepared, (state) => matching(state.convo).length), 1)
    await executePreparedToolsLoop(prepared)
    assert.ok(requests.length > 0)
    for (const outbound of requests) assert.equal(matching(outbound).length, 1)
    assert.deepEqual(messages, original)
  })
}
