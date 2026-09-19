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
It now runs only on explicit manual dispatch; the temporary branch-push trigger
used during diagnosis has been removed to avoid duplicate hosted work. Checkout
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

Candidate `001be6a` subsequently passed hosted run `35435640465`, job
`105877694650`, with unchanged startup/caller deadlines. READY was observed at
3027ms, 234ms and 226ms, and cleanup was confirmed for all three workers.
Explicit Utility import took 290/28/28ms; native compilation took 572/64/62ms.
The same job completed 70 process-isolation and real CLI artifact regressions:
68 passed, 2 platform-specific skips, 0 failures. This verifies that the pinned
dependency path eliminates the reproduced slow unqualified lookup on that
hosted run; it is not a promise that every future machine starts within a fixed
latency. The baseline failure remains in the record.

On the user's subsequent instruction, no further incremental version bump,
push, tag or hosted build is allowed during repair. Final code, CLI/Web checks
and packaging validation are to be completed locally first. Version naming and
one consolidated delivery are to be confirmed after acceptance; existing tags
are not rewritten. The current package version is not a new published Release.

Final local acceptance completed after that instruction: 1029 files / 9074
tests, with 9065 passed, 9 skipped, 0 failed and 0 cancelled. The desktop ASAR
verifier now requires all four worker modules and tests each missing-file case.
A newly built unsigned local package passed backend health and real command
execution from Electron 43.3.0 / Node 24.18.1, plus pre-cancelled command refusal.
Its six process-gate/worker source files matched the frozen workspace bytes.
No further commit, push, tag, version change or remote build was performed;
publication and final version naming remain separate from this local evidence.

The user subsequently selected the existing 0.11.61 version for the consolidated
delivery. The remote tag still named the failed `6e99b20dd1bcfe853e7ef58719cea9267fbf2bef`
commit, and authenticated release discovery found no published or draft Release
for it. Only that unpublished-release tag is to be aligned with the final
validated commit using its exact old ref as a lease; branch updates must remain
fast-forward. Earlier tags and commit history stay unchanged. The required
Release CI, signing-policy, checksum and provenance gates remain unchanged.
