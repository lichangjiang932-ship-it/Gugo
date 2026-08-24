import test from 'node:test'

test('timeout probe', async () => {
  await new Promise(() => setInterval(() => {}, 1_000))
})
