import { TURN_EVENT_TYPES } from '../../shared/turnEvents.js'
import {
  collectAgentEventSubscriptionSchemaProblems,
} from '../agentEventSubscriptionSchemaContract.js'
import { databaseSchemaIncompleteError } from '../dbSchemaContract.js'

const VERSION = 115
const EVENT_TYPE_SQL = TURN_EVENT_TYPES.map((type) => `'${type.replaceAll("'", "''")}'`).join(', ')

function assertV115Schema(db) {
  const missing = collectAgentEventSubscriptionSchemaProblems(db)
  if (missing.length > 0) {
    throw databaseSchemaIncompleteError({
      expectedVersion: VERSION,
      stage: 'migration-v115',
      missing,
    })
  }
}

/**
 * Scope durable Agent Event subscriptions to one host-authenticated user.
 *
 * V114 subscriptions had no owner identity and could therefore have consumed
 * another tenant's outbox entries. Their cursors and DLQ rows cannot be
 * attributed safely after the fact, so this security migration deliberately
 * drops them. Enabled local-owner plugins create fresh, owner-bound
 * subscriptions during runtime restore.
 */
export function migrateToV115(db) {
  db.exec(`
    DROP TABLE IF EXISTS agent_event_subscription_dlq;
    DROP TABLE IF EXISTS agent_event_subscriptions;

    CREATE TABLE agent_event_subscriptions (
      subscription_key TEXT PRIMARY KEY NOT NULL CHECK (
        length(subscription_key) = 64
        AND subscription_key NOT GLOB '*[^0-9a-f]*'
      ),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        CHECK (length(user_id) BETWEEN 1 AND 256),
      publisher_id TEXT NOT NULL CHECK (length(publisher_id) BETWEEN 1 AND 128),
      publisher_key_id TEXT NOT NULL CHECK (length(publisher_key_id) BETWEEN 1 AND 256),
      package_digest TEXT NOT NULL CHECK (
        length(package_digest) = 71
        AND substr(package_digest, 1, 7) = 'sha256-'
        AND substr(package_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      publication_digest TEXT NOT NULL CHECK (
        length(publication_digest) = 71
        AND substr(publication_digest, 1, 7) = 'sha256-'
        AND substr(publication_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 1 AND 128),
      release_content_digest TEXT NOT NULL CHECK (
        length(release_content_digest) = 71
        AND substr(release_content_digest, 1, 7) = 'sha256-'
        AND substr(release_content_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      release_digest_version INTEGER NOT NULL CHECK (
        typeof(release_digest_version) = 'integer' AND release_digest_version >= 1
      ),
      plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 80),
      plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 128),
      subscription_id TEXT NOT NULL CHECK (length(subscription_id) BETWEEN 1 AND 128),
      event_type TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPE_SQL})),
      contract_version INTEGER NOT NULL CHECK (
        typeof(contract_version) = 'integer' AND contract_version = 2
      ),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      acked_cursor INTEGER NOT NULL CHECK (
        typeof(acked_cursor) = 'integer' AND acked_cursor >= 0
      ),
      scanned_cursor INTEGER NOT NULL CHECK (
        typeof(scanned_cursor) = 'integer' AND scanned_cursor >= acked_cursor
      ),
      stream_epoch INTEGER NOT NULL CHECK (
        typeof(stream_epoch) = 'integer' AND stream_epoch >= 1
      ),
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL CHECK (
        typeof(lease_generation) = 'integer' AND lease_generation >= 0
      ),
      lease_expires_at INTEGER,
      retry_cursor INTEGER,
      retry_attempts INTEGER NOT NULL CHECK (
        typeof(retry_attempts) = 'integer' AND retry_attempts >= 0
      ),
      retry_not_before INTEGER,
      retry_max_attempts INTEGER NOT NULL CHECK (
        typeof(retry_max_attempts) = 'integer' AND retry_max_attempts BETWEEN 1 AND 100
      ),
      retry_base_delay_ms INTEGER NOT NULL CHECK (
        typeof(retry_base_delay_ms) = 'integer'
        AND retry_base_delay_ms BETWEEN 1 AND 604800000
      ),
      retry_max_delay_ms INTEGER NOT NULL CHECK (
        typeof(retry_max_delay_ms) = 'integer'
        AND retry_max_delay_ms BETWEEN retry_base_delay_ms AND 604800000
      ),
      created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND created_at >= 0
      ),
      updated_at INTEGER NOT NULL CHECK (
        typeof(updated_at) = 'integer' AND updated_at >= created_at
      ),
      CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (
          lease_owner IS NOT NULL
          AND length(lease_owner) BETWEEN 1 AND 256
          AND typeof(lease_expires_at) = 'integer'
          AND lease_expires_at >= 0
        )
      ),
      CHECK (
        (retry_cursor IS NULL AND retry_attempts = 0 AND retry_not_before IS NULL)
        OR (
          typeof(retry_cursor) = 'integer'
          AND retry_cursor > scanned_cursor
          AND retry_attempts BETWEEN 1 AND retry_max_attempts - 1
          AND typeof(retry_not_before) = 'integer'
          AND retry_not_before >= 0
        )
      )
    );

    CREATE TABLE agent_event_subscription_dlq (
      dlq_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
        typeof(dlq_id) = 'integer' AND dlq_id > 0
      ),
      subscription_key TEXT NOT NULL
        REFERENCES agent_event_subscriptions(subscription_key) ON DELETE CASCADE,
      cursor INTEGER NOT NULL CHECK (typeof(cursor) = 'integer' AND cursor > 0),
      event_type TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPE_SQL})),
      failure_code TEXT NOT NULL CHECK (
        length(failure_code) BETWEEN 1 AND 128
        AND failure_code NOT GLOB '*[^A-Z0-9_]*'
      ),
      attempts INTEGER NOT NULL CHECK (
        typeof(attempts) = 'integer' AND attempts BETWEEN 1 AND 100
      ),
      failed_at INTEGER NOT NULL CHECK (
        typeof(failed_at) = 'integer' AND failed_at >= 0
      ),
      UNIQUE(subscription_key, cursor)
    );

    CREATE INDEX idx_agent_event_subscriptions_user_status
      ON agent_event_subscriptions(user_id, status, subscription_key);
    CREATE INDEX idx_agent_event_subscriptions_retention
      ON agent_event_subscriptions(status, stream_epoch, scanned_cursor);
    CREATE INDEX idx_agent_event_subscriptions_lease
      ON agent_event_subscriptions(status, lease_expires_at, subscription_key);
    CREATE INDEX idx_agent_event_subscription_dlq_time
      ON agent_event_subscription_dlq(subscription_key, failed_at, dlq_id);
    CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_user_type_cursor
      ON agent_event_outbox(user_id, event_type, cursor);
  `)
  assertV115Schema(db)
}
