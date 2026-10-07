export function projectOutcome(value) {
  return value?.status === 'failed' ? 'failed' : 'completed'
}
