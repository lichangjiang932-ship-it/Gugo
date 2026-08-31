import { LEGACY_SCHEMA_MIGRATIONS_V2_TO_V13 } from './legacyV2ToV13.js'
import { LEGACY_SCHEMA_MIGRATIONS_V14_TO_V30 } from './legacyV14ToV30.js'

// Keep the historical v2-v30 sequence identical to the former inline registry.
const legacyMigrationFunctions = [
  ...LEGACY_SCHEMA_MIGRATIONS_V2_TO_V13,
  ...LEGACY_SCHEMA_MIGRATIONS_V14_TO_V30,
]

export const LEGACY_SCHEMA_MIGRATIONS = legacyMigrationFunctions
  .map((up, index) => ({ version: index + 2, up }))
