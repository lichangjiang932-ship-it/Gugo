export function buildPresentationPlannerPrompt(topic = '') {
  const request = String(topic ?? '')
  // Legacy callers may still pass skillId options. They do not authorize a
  // different template, count, output syntax, font or color scheme.
  return request.trim() ? `\n\n## User presentation request\n${request}` : ''
}
