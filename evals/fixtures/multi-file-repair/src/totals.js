export function sumAmounts(records) {
  return records.reduce((total, record) => total + Math.max(0, record.amount || 0), 0)
}
