// @ts-check

/**
 * Local calendar-date parsing shared by the CLI's `--since` filters.
 *
 * `new Date(2026, 12, 45)` rolls forward to 2027-02-14 rather than failing, so a
 * format-only pattern silently accepts an impossible date and quietly moves the
 * window a caller asked for. Every component is checked by round-tripping it.
 *
 * A value is `yyyy-mm-dd` or `yyyy-mm-ddTHH:mm` (a space is accepted in place of
 * `T`); the time defaults to local midnight. Epoch millisecond strings are only
 * accepted when `allowEpochMs` is set, because a raw number is meaningful for a
 * report window but not for a Git history bound.
 */
export const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/u

/**
 * @returns {{ok: true, ms: number} | {ok: false}}
 */
export function parseLocalDateTime(value, { allowEpochMs = false } = {}) {
  const text = String(value ?? '').trim()
  if (!text) return { ok: false }
  if (allowEpochMs && /^\d+$/u.test(text)) {
    const numeric = Number(text)
    return Number.isSafeInteger(numeric) && numeric > 0 ? { ok: true, ms: numeric } : { ok: false }
  }
  const match = LOCAL_DATE_TIME_PATTERN.exec(text)
  if (!match) return { ok: false }
  const [, year, month, day, hour = '00', minute = '00'] = match
  const parsed = new Date(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0,
  )
  const rolledForward = Number.isNaN(parsed.getTime())
    || parsed.getFullYear() !== Number(year)
    || parsed.getMonth() !== Number(month) - 1
    || parsed.getDate() !== Number(day)
    || parsed.getHours() !== Number(hour)
    || parsed.getMinutes() !== Number(minute)
  return rolledForward ? { ok: false } : { ok: true, ms: parsed.getTime() }
}

/** Echo a filter back in the shape a caller typed it in, in local time. */
export function formatLocalDateTime(epochMs) {
  const date = new Date(Number(epochMs))
  if (Number.isNaN(date.getTime())) return String(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
