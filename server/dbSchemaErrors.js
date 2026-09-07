/** Stable fail-closed error contract shared by migrations and startup checks. */
export function databaseSchemaIncompleteError({ expectedVersion, stage, missing }) {
  return Object.assign(
    new Error(
      `Database schema is incomplete for version ${expectedVersion}: ${missing.join(', ')}.`,
    ),
    {
      code: 'DB_SCHEMA_INCOMPLETE',
      retryable: false,
      details: {
        expectedVersion,
        stage,
        missing: [...missing],
      },
    },
  )
}
