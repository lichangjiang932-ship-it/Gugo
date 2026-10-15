import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createContextUsageEstimator, estimateClientContextUsage } from '../src/lib/contextUsage.js'

const count = 2000
const updates = 30
const messages = Array.from({ length: count }, (_, index) => Object.freeze({
  id: `benchmark-${index}`, role: index % 2 ? 'assistant' : 'user',
  content: (`An offline context estimate fixture ${index}. 中文内容与代码结果。 `).repeat(12),
}))
const tools = Object.freeze(Array.from({ length: 60 }, (_, index) => ({ type: 'function', function: {
  name: `fixture_tool_${index}`, description: 'A deterministic schema fixture.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } } },
} })))
const variants = Array.from({ length: updates }, (_, index) => ({ messages: [...messages.slice(0, -1), {
  ...messages.at(-1), content: `${messages.at(-1).content} delta ${index}`,
}], tools, systemPrompt: 'Offline benchmark only; no model, keys or user data.', contextWindow: 128000 }))
const baseline = []
const measure = (run) => variants.map((options, index) => {
  const started = performance.now()
  const result = run(options)
  const elapsed = performance.now() - started
  if (baseline[index]) assert.deepEqual(result, baseline[index])
  else baseline[index] = result
  return elapsed
})
const direct = measure(estimateClientContextUsage)
const memoized = createContextUsageEstimator()
const cached = measure(memoized)
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3)) }
}
assert.equal(memoized.stats().toolsComputed, 1)
assert.equal(memoized.stats().messagesComputed, count - 1 + updates)
process.stdout.write(JSON.stringify({ version: 1, fixture: { messages: count, tools: tools.length, updates },
  correctness: 'identical numeric results', baseline: summarize(direct), memoized: summarize(cached),
  work: memoized.stats(), scope: 'Node-side client-estimate benchmark, not UI FPS, provider KV cache or live model performance',
}, null, 2) + '\n')
