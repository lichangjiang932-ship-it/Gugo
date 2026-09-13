import { snapshotDurableAgentEventStore } from '../../../server/core/durableAgentEventConsumerHostSupport.js'
import type { DurableAgentEventStore } from '../../kernel-ports.js'

const store: DurableAgentEventStore = {
  ensureAgentEventSubscription: () => null,
  enableAgentEventSubscription: () => null,
  disableAgentEventSubscription: () => null,
  acquireAgentEventSubscriptionLease: () => null,
  renewAgentEventSubscriptionLease: () => null,
  releaseAgentEventSubscriptionLease: () => null,
  scanAgentEventSubscription: () => null,
  acknowledgeAgentEventSubscription: () => null,
  failAgentEventSubscription: 42,
  truncateAgentEventOutboxToSafeWatermark: () => null,
}

snapshotDurableAgentEventStore(store)
