export function buildReport(records) {
  const total = records.reduce((sum, record) => sum + record.value, 0)
  const average = records.length ? total / Math.max(1, records.length - 1) : 0
  const highest = records.sort((left, right) => right.value - left.value)[0] || null
  return { total, average, highest }
}
