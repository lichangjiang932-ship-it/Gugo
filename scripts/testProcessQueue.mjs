/** Independent processes may overlap; memory-sensitive cases keep an exclusive lane. */
export async function runTestProcessQueue(items, {
  concurrency = 1,
  isExclusive = () => false,
  run,
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer')
  if (typeof run !== 'function') throw new TypeError('run must be a function')
  const results = new Array(items.length)
  let group = []

  async function drain() {
    const pending = group
    group = []
    let cursor = 0
    let failure = null
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (cursor < pending.length && !failure) {
        const { item, index } = pending[cursor++]
        try { results[index] = await run(item, index) } catch (error) { failure ||= { error } }
      }
    }))
    if (failure) throw failure.error
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (isExclusive(item)) {
      await drain()
      results[index] = await run(item, index)
    } else group.push({ item, index })
  }
  await drain()
  return results
}
