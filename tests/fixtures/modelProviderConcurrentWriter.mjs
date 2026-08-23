const [mode, payloadJson] = process.argv.slice(2)
const payload = JSON.parse(payloadJson)

process.env.APP_DB_PATH = payload.dbPath

const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../../server/services/modelProviderStore.js')
const { closeDb } = await import('../../server/db.js')

let result
try {
  if (mode === 'config') {
    const provider = upsertModelProvider({
      userId: payload.userId,
      provider: payload.provider,
    })
    result = { ok: true, provider }
  } else if (mode === 'readiness') {
    const provider = recordModelProviderReadiness(payload)
    result = provider
      ? { ok: true, provider }
      : { ok: false, code: 'MODEL_PROVIDER_CONFIG_CHANGED' }
  } else {
    throw new TypeError(`unsupported provider writer mode: ${mode}`)
  }
} catch (error) {
  result = {
    ok: false,
    code: String(error?.code || 'MODEL_PROVIDER_WRITE_FAILED'),
    message: String(error?.message || error),
  }
} finally {
  closeDb()
}

process.stdout.write(JSON.stringify(result))
