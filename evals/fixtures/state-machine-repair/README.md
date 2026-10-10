# state-machine-repair

`nextStatus(status, event)` advances a tiny order lifecycle. It currently returns the
unchanged status for an invalid event and the string `'unknown'` for a terminal/unknown
status, both of which are wrong.

Correct behaviour (see the prompt):

- A valid transition returns the destination status (`placed + pay → paid`, etc.).
- An **invalid event** for a live status returns `null` (rejected) — never the same status.
- A **terminal** status (`delivered`, `cancelled`, `refunded`) has no outgoing moves: any
  event returns `null`.
- An **unknown** status returns `null`.

Run the checks with `npm test`.
