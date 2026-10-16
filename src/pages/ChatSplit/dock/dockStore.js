/**
 * Whether the change review is open over the right region.
 *
 * The review is the only panel left here. It used to be one of four — the task
 * list shared this slot and the browser and the terminal were routed into it —
 * but the task list is a pane of its own now and those two are workbench tools,
 * so nothing else has to compete for the region.
 *
 * The store stays because the chip that asks for the review lives in the chat
 * header and the menu item that asks for it lives in the workbench: two places
 * that would otherwise thread the same boolean through five components.
 */
import { WIRED_COMPARE_MODES } from '../../../lib/diffReviewModel.js'

const listeners = new Set()
let state = Object.freeze({ panel: '', revision: 0 })

export function readDockState() {
  return state
}

export function openDock(targetMode = '') {
  const mode = WIRED_COMPARE_MODES.includes(targetMode) ? targetMode : ''
  if (state.panel === 'diff' && (!mode || mode === state.targetMode)) return state
  state = Object.freeze({ panel: 'diff', revision: state.revision + 1, ...(mode ? { targetMode: mode } : {}) })
  for (const listener of listeners) listener(state)
  return state
}

export function closeDock() {
  if (!state.panel) return state
  state = Object.freeze({ panel: '', revision: state.revision + 1 })
  for (const listener of listeners) listener(state)
  return state
}

export function subscribeDock(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetDockForTests() {
  state = Object.freeze({ panel: '', revision: 0 })
  listeners.clear()
}
