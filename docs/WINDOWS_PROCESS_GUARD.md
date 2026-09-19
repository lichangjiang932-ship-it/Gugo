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
code nonzero; these are not retries until green. They are separate workers on
one host, not three independently cold machines. The script prints only runtime
version, whitelisted stages and spawn/write/exit/close times. Evidence is printed
before cleanup; close has its own five-second bound. Unconfirmed cleanup keeps
the directory, stops further trials and fails the diagnostic rather than hiding
the evidence until the job deadline. Confirmed cleanup removes only the fixture.

The `Windows process guard diagnostics` workflow provides a short hosted
Windows/Node 22 check of these probes and the existing isolation, cancellation
and CLI artifact regressions. It has read-only repository permissions. It is
not a replacement for any required Release CI gate or installer validation.
Relevant branch pushes and an explicit manual dispatch can run it; checkout
does not persist GitHub credentials. It neither tags nor publishes anything.

## Pin native compilation to the system dependency

An independently reproduced trust-boundary defect affected unqualified
`Add-Type`: an identically named Utility module on the ambient `PSModulePath`
could execute while the isolation guard was starting. The worker now explicitly
imports the Utility manifest under its own `$PSHOME`, takes the exported native
`CmdletInfo`, and invokes it directly. UTF-8 output encoding uses a constructor,
not an autoloadable `New-Object` command. Missing system dependencies fail closed;
there is no fallback to ambient module search. User-command environment and
PowerShell configuration are not changed.

Real WinPS 5.1 tests first demonstrate that the same isolated environment really
autoloads a synthetic shadow module; the worker then rejects that module and
binds/kills a test-owned native process with the trusted implementation. A missing
builtin manifest denies command execution and never loads the shadow fallback.
This is a separately proven fix, not proof of the v0.11.61 hosted timeout cause.

The generated native Job Object / process-identity implementation lives in
`windowsTreeKillNativeSource.js`; PowerShell bootstrap, dependency binding and
protocol dispatch remain in `windowsTreeKillWorkerSource.js`. This separates
native interop from host startup rather than compressing the combined file to
evade the size gate. The complete generated worker's SHA-256 was checked before
and after this extraction and was identical; native cleanup behavior is unchanged.

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

## Hosted startup-stage reproduction

Diagnostic-only commit `2bd16af` retained the unqualified dependency call and
the original deadlines. Run `35433488405`, job `105872119318`, reproduced the
failure without starting a user command: trial 1 entered `add_type_begin` at
2417ms and timed out at 30026ms. Trial 2 spent about 24.5 seconds inside that
call and reached READY at 24750ms; trial 3 spent about 22.6 seconds and reached
READY at 22864ms. The command exited 1, preserving the first trial's failure.

These observations narrow the delay to unqualified `Add-Type` (including any
autoload and compilation work); they do not distinguish its internal stages.
The explicit-system-dependency implementation requires its own hosted result
before it can be described as resolving this performance failure. The log is
`windows-worker-baseline-cloud.log`; a later success must not erase it.
