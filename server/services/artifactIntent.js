// Compatibility path for existing service consumers. The loop kernel owns
// the implementation so intent parsing and delivery guards share one module.
export * from './loop/artifactIntent.js'
