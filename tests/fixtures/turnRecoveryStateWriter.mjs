const [scopeJson, candidateVersion, attemptsText] = process.argv.slice(2)
const scope = JSON.parse(scopeJson)
const attempts = Number(attemptsText)

if (!Number.isInteger(attempts) || attempts < 1) {
  throw new TypeError('writer attempts must be a positive integer')
}

const { recordTurnRecoveryFailure } = await import(
  '../../server/services/turnRecoveryStateStore.js'
)
const { closeDb } = await import('../../server/db.js')

try {
  for (let index = 0; index < attempts; index += 1) {
    recordTurnRecoveryFailure({
      ...scope,
      candidateVersion,
      retryable: true,
      errorCode: 'CONCURRENT_FAILURE',
      errorMessage: 'concurrent failure',
      now: Date.now(),
      maxAttempts: 1_000,
      random: () => 0,
    })
  }
} finally {
  closeDb()
}
