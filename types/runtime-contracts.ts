import type { z } from 'zod'

import {
  PersistedTurnEventSchema,
  TURN_EVENT_PAYLOAD_SCHEMAS,
  TurnEventSchema,
  TurnEventTransportEnvelopeSchema,
} from '../shared/turnEvents.js'
import {
  COMPACTION_ARCHIVE_PORT_VERSION,
  createCompactionArchivePort,
} from '../server/core/compactionArchivePort.js'
import {
  MANAGED_ATTACHMENT_GOVERNANCE_METHODS,
  MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION,
  createManagedAttachmentGovernancePort,
} from '../server/core/managedAttachmentGovernancePort.js'
import {
  MANAGED_ATTACHMENT_RUNTIME_PORT_METHODS,
  MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
  prepareManagedAttachmentRuntimePort,
} from '../server/core/managedAttachmentRuntimePort.js'
import {
  MANAGED_ATTACHMENT_STORAGE_PORT_METHODS,
  MANAGED_ATTACHMENT_STORAGE_PORT_VERSION,
  createManagedAttachmentStoragePort,
} from '../server/core/managedAttachmentStoragePort.js'
import {
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
  SESSION_ADMIN_PORT_METHODS,
  prepareSessionAdminPort,
} from '../server/core/sessionAdminPort.js'
import {
  SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
  SUBAGENT_RUN_PERSISTENCE_PORT_METHODS,
  prepareSubagentRunPersistencePort,
} from '../server/core/subagentRunPersistencePort.js'

type Assert<T extends true> = T
type CoversMethods<Port, Methods extends readonly string[]> =
  Exclude<Methods[number], keyof Port> extends never ? true : false
type RuntimePortMethods<Methods extends readonly string[]> = {
  [Method in Methods[number]]: (input: unknown) => unknown
}

/** Static types are derived from the authoritative Zod schemas, never copied. */
export type TurnEvent = z.infer<typeof TurnEventSchema>
export type PersistedTurnEvent = z.infer<typeof PersistedTurnEventSchema>
export type TurnEventTransportEnvelope = z.infer<typeof TurnEventTransportEnvelopeSchema>
export type TurnEventType = keyof typeof TURN_EVENT_PAYLOAD_SCHEMAS
export type TurnEventPayload<Type extends TurnEventType> =
  z.infer<(typeof TURN_EVENT_PAYLOAD_SCHEMAS)[Type]>

/** Stable runtime-port types are derived from their checked implementation factories. */
export type CompactionArchivePort = ReturnType<typeof createCompactionArchivePort>
export type ManagedAttachmentGovernancePort =
  ReturnType<typeof createManagedAttachmentGovernancePort>
  & RuntimePortMethods<typeof MANAGED_ATTACHMENT_GOVERNANCE_METHODS>
export type ManagedAttachmentRuntimePort = ReturnType<typeof prepareManagedAttachmentRuntimePort>
export type ManagedAttachmentStoragePort =
  ReturnType<typeof createManagedAttachmentStoragePort>
  & RuntimePortMethods<typeof MANAGED_ATTACHMENT_STORAGE_PORT_METHODS>
export type SessionAdminPort = ReturnType<typeof prepareSessionAdminPort>
export type SubagentRunPersistencePort = ReturnType<typeof prepareSubagentRunPersistencePort>

export const RUNTIME_CONTRACT_VERSIONS = Object.freeze({
  compactionArchive: COMPACTION_ARCHIVE_PORT_VERSION,
  managedAttachmentGovernance: MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION,
  managedAttachmentRuntime: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
  managedAttachmentStorage: MANAGED_ATTACHMENT_STORAGE_PORT_VERSION,
  sessionAdmin: SESSION_ADMIN_PORT_CONTRACT_VERSION,
  subagentRunPersistence: SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
})

type _ManagedAttachmentGovernanceMethods = Assert<CoversMethods<
  ManagedAttachmentGovernancePort,
  typeof MANAGED_ATTACHMENT_GOVERNANCE_METHODS
>>
type _ManagedAttachmentRuntimeMethods = Assert<CoversMethods<
  ManagedAttachmentRuntimePort,
  typeof MANAGED_ATTACHMENT_RUNTIME_PORT_METHODS
>>
type _ManagedAttachmentStorageMethods = Assert<CoversMethods<
  ManagedAttachmentStoragePort,
  typeof MANAGED_ATTACHMENT_STORAGE_PORT_METHODS
>>
type _SessionAdminMethods = Assert<CoversMethods<SessionAdminPort, typeof SESSION_ADMIN_PORT_METHODS>>
type _SubagentPersistenceMethods = Assert<CoversMethods<
  SubagentRunPersistencePort,
  typeof SUBAGENT_RUN_PERSISTENCE_PORT_METHODS
>>

export type RuntimeContractCoverage = {
  managedAttachmentGovernance: _ManagedAttachmentGovernanceMethods
  managedAttachmentRuntime: _ManagedAttachmentRuntimeMethods
  managedAttachmentStorage: _ManagedAttachmentStorageMethods
  sessionAdmin: _SessionAdminMethods
  subagentRunPersistence: _SubagentPersistenceMethods
}
