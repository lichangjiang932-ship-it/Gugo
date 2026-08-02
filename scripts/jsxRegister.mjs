import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// Register the JSX transform hook before node:test imports a component test.
register('./jsxLoader.mjs', pathToFileURL(import.meta.filename))
