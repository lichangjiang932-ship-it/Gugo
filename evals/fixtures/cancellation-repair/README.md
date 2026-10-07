# Cancellable worker

`runTask({signal, work})` should reject with the signal's abort reason without
starting work if already cancelled. During work it must settle on cancellation
and ignore late results. Ordinary successful work remains unchanged.
