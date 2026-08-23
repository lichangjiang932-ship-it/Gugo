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
function LiveElapsed({ className = '' }) {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <span className={className} data-testid="live-elapsed" aria-hidden="true">
      {formatElapsed(seconds)}
    </span>
  )
}

export default memo(LiveElapsed)
