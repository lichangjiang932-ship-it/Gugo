# Windows process guard startup and diagnostics

Windows commands must wait for the process-tree worker's exact `READY\t2`
stdout handshake before the process gate or user command can start. The worker
has a 30-second startup bound; each caller's own deadline and abort signal can
stop waiting sooner. Diagnostic messages do not authorize execution and do not
extend either deadline. A failed worker rejects its waiters and is terminated.

## Safe startup evidence

The worker reports a fixed set of startup stages on a separate stderr pipe:
bootstrap entry, source receipt/decoding, worker entry, dependency import and
native compilation. The runtime drains that pipe but retains only known stage
names and monotonic elapsed times. Arbitrary PowerShell errors, source text,
paths and environment values are not retained in these diagnostics; a partial
line is bounded to 128 characters. The stdout protocol is unchanged.

An error before READY includes `startup phase=..., elapsedMs=...`. It identifies
the last *observed* stage, not a claimed root cause. Separate stdout/stderr pipes
may be delivered in different orders. A stderr marker cannot mark the worker
ready, finish a tool, or substitute for process-tree cleanup proof.

Run `node scripts/diagnostics/windows-worker-startup.js` on Windows for three
independent readiness-only probes in fresh temporary profiles. No user command,
model, database, or real user profile is opened. Every failure keeps the exit
code nonzero; these are not retries until green. The script prints only runtime
version and whitelisted stages, stops its own worker, waits for close and removes
its own temporary directory.

The `Windows process guard diagnostics` workflow provides a short hosted
Windows/Node 22 check of these probes and the existing isolation, cancellation
and CLI artifact regressions. It has read-only repository permissions. It is
not a replacement for any required Release CI gate or installer validation.

## Preserved v0.11.61 failure evidence

Main CI `35428463792` passed, including its Windows suite. Release run
`35428463915` failed Windows job `105858514200`. One fresh-runner check of the
same SHA was allowed; attempt 2 also failed in job `105864651166`. The final
release job was skipped; v0.11.61 has no published release assets.

The repeated failure is `PROCESS_ISOLATION_FAILED`, caused by
`WINDOWS_TREE_KILL_WORKER_START_TIMEOUT` at approximately 30.3 seconds, before
the fixture's 35-second command deadline. The CLI's outer deadline did not fire.
The writer script existed but the PPT did not. The native gate and user command
were not started on this rejection path. `tool.started` is only a scheduling
event and is not evidence of OS command execution.

The old implementation discarded worker stderr, so those runs cannot identify
the slow stage. The CLI fixture does not inherit `PSModulePath`; inherited extra
module paths must not be asserted as their root cause. No further blind reruns,
deadline increase, test removal or security fallback are justified by these
records. Full logs remain in the local ignored QA evidence directory.
