export function notifyUiContributionListeners(listeners) {
  const batch = [...listeners]
  for (const listener of batch) {
    try {
      listener()
    } catch {
      // UI observers cannot change contribution registry lifecycle outcomes.
    }
  }
}
