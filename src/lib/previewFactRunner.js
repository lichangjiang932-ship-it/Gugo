import {
  captureDesktopPreview,
  evaluateInDesktopPreview,
  getDesktopBrowserHost,
  readDesktopPreviewConsole,
} from './desktopBrowserClient.js'
import { deliverPreviewFacts } from './previewClient.js'
import { planFactsOperations } from './previewPageScripts.js'

/**
 * Perform one page-facts request against the live view.
 *
 * The seams are injectable so the whole path can be tested without Electron: in
 * the app they are the docked view, in a test they are whatever the test says the
 * page did. One failing step does not abandon the rest — a verification wants the
 * screenshot even when the selector it was asked about is gone.
 */
export async function runPreviewFacts(request, {
  capture = captureDesktopPreview,
  evaluate = evaluateInDesktopPreview,
  consoleEntries = readDesktopPreviewConsole,
  getHost = getDesktopBrowserHost,
} = {}) {
  const results = []
  const errors = []
  for (const step of planFactsOperations(request?.ops)) {
    try {
      if (step.kind === 'screenshot') results.push({ kind: 'screenshot', ...await capture() })
      else if (step.kind === 'console') results.push({ kind: 'console', ...await consoleEntries({ clear: true }) })
      else if (step.kind === 'navigate') results.push({ kind: 'navigate', ...await getHost()?.navigate(step.url) })
      else results.push({ kind: step.kind, ...await evaluate(step.script) })
    } catch (error) {
      errors.push({ kind: step.kind, message: error?.message || String(error) })
    }
  }
  return { results, errors }
}

/**
 * Collect and hand back, for the panel's poll loop.
 *
 * A request that has already been answered in this session is remembered: the
 * poll runs every couple of seconds, and running the same click twice because a
 * response was slow would be the panel acting on the page twice.
 */
export function createFactsRelay({ run = runPreviewFacts, deliver = deliverPreviewFacts } = {}) {
  const answered = new Set()
  return async function relayPendingFacts({ workspaceRoot, requests } = {}) {
    const list = Array.isArray(requests) ? requests : []
    for (const request of list) {
      if (!request?.id || answered.has(request.id)) continue
      answered.add(request.id)
      // Bounded: the ids are per page session and this set lives as long as the
      // panel does, but a long-lived panel should not hold every id forever.
      if (answered.size > 200) answered.clear()
      const outcome = await run(request)
      await deliver({ workspaceRoot, id: request.id, ...outcome })
    }
  }
}
