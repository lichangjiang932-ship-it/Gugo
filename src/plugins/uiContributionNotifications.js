function suppressNativePromiseRejection(value) {
  try {
    Promise.prototype.then.call(value, undefined, () => {})
  } catch {
    // Non-Promise results, Proxies, and custom thenables are intentionally ignored.
  }
}

export function notifyUiContributionListeners(listeners) {
  const batch = [...listeners]
  for (const listener of batch) {
    try {
      suppressNativePromiseRejection(listener())
    } catch {
      // UI observers cannot change contribution registry lifecycle outcomes.
    }
  }
}
