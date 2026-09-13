/** Large function arguments may arrive in buffered bursts. Keep a finite idle
 * grace, scaled to the configured deadline, and never count keepalives as work. */
export function modelToolArgumentsIdleMs(idleMs) {
  const base = Number(idleMs)
  if (!Number.isFinite(base) || base <= 0) return 180_000
  return Math.max(base, Math.min(base * 3, 360_000))
}
