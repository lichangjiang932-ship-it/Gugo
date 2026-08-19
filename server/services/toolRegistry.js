// Compatibility service entry point. The canonical schema catalog and its
// dynamic registry live in server/utils/toolSchemaCatalog.js so API discovery
// and execution validation cannot import different definitions.
export * from '../utils/toolSchemaCatalog.js'
