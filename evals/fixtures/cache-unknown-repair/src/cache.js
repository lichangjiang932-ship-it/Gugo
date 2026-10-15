export function classify(usage) { return { readReported: true, writeReported: !!usage.cacheCreationTokens, hitRate: (usage.cacheHitTokens || 0) / (usage.promptTokens || 1) * 100 } }
