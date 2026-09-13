export type MaybePromise<Value> = Value | PromiseLike<Value>

export type DurableAgentEventStoreMethod = (...args: unknown[]) => unknown
export type DurableAgentEventStore = {
  ensureAgentEventSubscription: DurableAgentEventStoreMethod
  enableAgentEventSubscription: DurableAgentEventStoreMethod
  disableAgentEventSubscription: DurableAgentEventStoreMethod
  acquireAgentEventSubscriptionLease: DurableAgentEventStoreMethod
  renewAgentEventSubscriptionLease: DurableAgentEventStoreMethod
  releaseAgentEventSubscriptionLease: DurableAgentEventStoreMethod
  scanAgentEventSubscription: DurableAgentEventStoreMethod
  acknowledgeAgentEventSubscription: DurableAgentEventStoreMethod
  failAgentEventSubscription: DurableAgentEventStoreMethod
  truncateAgentEventOutboxToSafeWatermark: DurableAgentEventStoreMethod
}
export type DurableAgentEventStoreSnapshot = Readonly<DurableAgentEventStore>
export type DurableAgentEventListener = (entry: unknown) => unknown
export type DurableAgentEventObserver =
  | ((entry: Readonly<Record<string, unknown>>) => unknown)
  | null
  | undefined
export type DurableAgentEventHostError = TypeError & {
  code: string
  retryable: false
}

export type LoopHostAdapterContractVersion = 2 | 3
export type LoopHostCapabilities = Readonly<{ loopBroker?: 1 }>
export type LoopHostAdapterDeclaration =
  | Readonly<{ contractVersion: 2; hostCapabilities?: LoopHostCapabilities }>
  | Readonly<{ contractVersion: 3; hostCapabilities: Readonly<{ loopBroker: 1 }> }>
export type LoopHostCapabilitySnapshot = Readonly<{
  apiVersion: 1
  adapterContractVersion: LoopHostAdapterContractVersion
  hostCapabilities: LoopHostCapabilities
}>
export type LoopHostCapabilityError = TypeError & {
  code: 'LOOP_HOST_CAPABILITY_DECLARATION_INVALID' | 'LOOP_HOST_ADAPTER_VERSION_UNSUPPORTED'
  retryable: false
}

export type ManagedAttachmentGovernanceOwnerInput = Readonly<{
  userId: string
  expectedSnapshot?: unknown
}>

export type ManagedAttachmentGovernanceOperationInput = Readonly<{
  userId: string
  operationId: string
  expectedSnapshot?: unknown
}>

export type ManagedAttachmentGovernanceStageHandle = Readonly<{
  assertStable(): unknown
  cleanup(): unknown
  rollback(): unknown
}>

export type ManagedAttachmentGovernanceAdapter = {
  apiVersion: 1
  id?: string | null
  captureUserClearSnapshot(input: ManagedAttachmentGovernanceOwnerInput): unknown
  stageUserClear(input: ManagedAttachmentGovernanceOperationInput): ManagedAttachmentGovernanceStageHandle
  rollbackUserClear(input: ManagedAttachmentGovernanceOperationInput): unknown
  cleanupUserClear(input: ManagedAttachmentGovernanceOperationInput): unknown
}

export type ManagedAttachmentGovernancePort = Readonly<{
  apiVersion: 1
  id: string
  captureUserClearSnapshot(input: ManagedAttachmentGovernanceOwnerInput): unknown
  stageUserClear(input: ManagedAttachmentGovernanceOperationInput): ManagedAttachmentGovernanceStageHandle
  rollbackUserClear(input: ManagedAttachmentGovernanceOperationInput): unknown
  cleanupUserClear(input: ManagedAttachmentGovernanceOperationInput): unknown
}>

export type ManagedAttachmentGovernanceError = TypeError & {
  code: 'MANAGED_ATTACHMENT_GOVERNANCE_PORT_INVALID'
  retryable: false
}
