export function chatSendOwnerScope(state) {
  return JSON.stringify([state?.sessionCatalogSource?.backendInstanceId || '', state?.user?.id || ''])
}
export function chatSendScope(state) {
  return JSON.stringify([chatSendOwnerScope(state), state?.activeSessionId
    ? ['session', state.activeSessionId]
    : ['draft', state?.newDraftVersion ?? 0]])
}
