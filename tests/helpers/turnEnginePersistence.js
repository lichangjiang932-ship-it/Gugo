import { SQLITE_TURN_PERSISTENCE_ADAPTER } from '../../server/adapters/sqliteTurnPersistenceAdapter.js'
import { prepareTurnPersistenceAdapter } from '../../server/core/turnPersistenceAdapter.js'
import { createTurnEnginePersistenceBundle } from '../../server/services/turnEnginePersistenceBundle.js'

const ADAPTER_SECTIONS = Object.freeze([
  'session',
  'eventLog',
  'transactions',
  'execution',
  'steering',
  'recovery',
  'modelRequestRecovery',
])

export const PREPARED_SQLITE_TURN_PERSISTENCE_ADAPTER = prepareTurnPersistenceAdapter(
  SQLITE_TURN_PERSISTENCE_ADAPTER,
)

export function createTestTurnEnginePersistence({
  adapter = PREPARED_SQLITE_TURN_PERSISTENCE_ADAPTER,
  sectionOverrides = {},
  leaseMs,
  renewalTimeoutMs,
  attachmentRuntime = null,
} = {}) {
  const preparedBase = adapter === PREPARED_SQLITE_TURN_PERSISTENCE_ADAPTER
    ? adapter
    : prepareTurnPersistenceAdapter(adapter)
  const overrideNames = Object.keys(sectionOverrides)
  const unknownSection = overrideNames.find((name) => !ADAPTER_SECTIONS.includes(name))
  if (unknownSection) throw new TypeError(`unknown Turn persistence section: ${unknownSection}`)

  const preparedAdapter = overrideNames.length === 0
    ? preparedBase
    : prepareTurnPersistenceAdapter({
        ...preparedBase,
        ...Object.fromEntries(ADAPTER_SECTIONS.map((name) => [
          name,
          {
            ...preparedBase[name],
            ...(sectionOverrides[name] || {}),
          },
        ])),
      })

  return createTurnEnginePersistenceBundle(preparedAdapter, {
    leaseMs,
    renewalTimeoutMs,
    attachmentRuntime,
  })
}
