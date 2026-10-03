import { memo, useEffect, useState } from 'react'

function formatElapsed(seconds) {
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * A tiny local clock for long-running model/tool activity. It deliberately
 * does not claim percentage progress; it only proves that the UI is alive and
 * tells the user how long the current phase has been running.
 */
function LiveElapsed({ className = '', startedAt, title }) {
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const origin = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : mountedAt
  const seconds = Math.max(0, Math.floor((now - origin) / 1000))

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <span className={className} data-testid="live-elapsed" title={title} aria-hidden="true">
      {formatElapsed(seconds)}
    </span>
  )
}

export default memo(LiveElapsed)
