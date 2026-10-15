# Controlled reliability fixture

Repair aggregate(events, {since=null}) in src/ledger.js. Events have userId/sessionId/turnId/type/sequence/at/promptTokens. Without since, count each scoped turn once and use its latest cumulative boundary by sequence, not the sum of paused/completed snapshots. With since, sum only valid completed model.phase counters at or after since. Count distinct boundary turns in that window. Ignore non-numeric, negative and non-finite counters. Do not mutate input.

The runner copies this synthetic workspace before execution. No external services or dependencies are needed.
