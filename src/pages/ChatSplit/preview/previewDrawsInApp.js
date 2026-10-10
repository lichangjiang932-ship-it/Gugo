import { classifyDirectFile } from '../../../lib/directFilePreview.js'
import { previewRendererRegistry } from './previewRendererRegistry.js'

/**
 * Whether this file's preview ends up in the app's own tree rather than in a
 * frame.
 *
 * The answer comes from the renderer descriptor that will draw it, so the flag
 * lives beside the renderer instead of being derived from the DOM. Only content
 * this app drew itself can be pointed at and pictured by a browser build; a
 * frame keeps its document in an opaque origin, and saying otherwise would offer
 * a control that cannot act.
 */
export function previewDrawsInApp(file) {
  if (!file) return false
  const preview = { ...file, label: String(file.type || '').toUpperCase() }
  const descriptor = previewRendererRegistry.resolve(classifyDirectFile(preview))
  return descriptor?.drawsInApp === true
}
