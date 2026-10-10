import { mergeById } from './records.js'

export function summarize(left, right) {
  const records = mergeById(left, right)
  return {
    count: records.length,
    total: records.reduce((sum, record) => sum + (Number(record.amount) || 0), 0),
  }
}
