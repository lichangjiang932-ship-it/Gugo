import { after } from 'node:test'
// Use the same JSX module graph as production components and the other unit tests.
// Avoid mixing Vite SSR with the native JSX test module graph.
await import('./mobileKeysUi.spec.jsx')
after(() => {
  delete globalThis.__YMA_LIST_MOBILE_KEYS__
  delete globalThis.__YMA_CREATE_MOBILE_KEY__
  delete globalThis.__YMA_REVOKE_MOBILE_KEY__
})
