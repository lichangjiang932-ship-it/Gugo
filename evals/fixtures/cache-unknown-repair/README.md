# Controlled reliability fixture

Repair classify(usage) in src/cache.js. Return {readReported,writeReported,hitRate}. Require finite non-negative numeric promptTokens plus a valid read count partition; derive one missing hit/miss count from promptTokens, and reject inconsistent partitions. Missing/invalid reads are unknown, never zero. cacheCreationTokens is independent: explicit zero is reported, absence/invalid is unknown. hitRate is a percentage or null for unknown/zero-input. Do not mutate input.

The runner copies this synthetic workspace before execution. No external services or dependencies are needed.
