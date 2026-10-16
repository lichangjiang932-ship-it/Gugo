import { createContext, createElement, useSyncExternalStore } from 'react'
import { MotionConfig } from 'framer-motion'
export const MotionEnabled = createContext(true)
const query = '(prefers-reduced-motion: reduce)'
function subscribe(listener) {
  const media = globalThis.window?.matchMedia?.(query)
  media?.addEventListener('change', listener)
  return () => media?.removeEventListener('change', listener)
}
const snapshot = () => Boolean(globalThis.window?.matchMedia?.(query).matches)
export function useMotionPreference(enabled = true) {
  const reduced = useSyncExternalStore(subscribe, snapshot, () => false)
  return enabled !== false && !reduced
}
export function HostMotionProvider({ enabled, children }) {
  return createElement(MotionEnabled.Provider, { value: enabled },
    createElement(MotionConfig, { reducedMotion: enabled ? 'user' : 'always' }, children))
}
