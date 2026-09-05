export async function discoverCodexExecutableStage({
  signal,
  explicitPath,
  env,
  platform,
  timeoutMs,
  resolveExecutable,
  runStage,
  notFoundReason,
}) {
  return runStage(
    (stageSignal) => resolveExecutable({ explicitPath, env, platform, signal: stageSignal }),
    { signal, timeoutMs, timeoutReason: notFoundReason },
  )
}

export async function verifyCodexExecutableStage({
  resolvedPath,
  signal,
  env,
  platform,
  timeoutMs,
  exitTimeoutMs,
  snapshotExecutable,
  verifySignature,
  runStage,
  assertActive,
  cleanupSnapshot,
  isNativePath,
  createRuntimeError,
  invalidSignatureReason,
}) {
  const snapshot = await runStage(
    (stageSignal) => snapshotExecutable(resolvedPath, { platform, signal: stageSignal }),
    {
      signal,
      timeoutMs,
      timeoutReason: invalidSignatureReason,
      onLateValue: (lateSnapshot) => cleanupSnapshot(lateSnapshot, exitTimeoutMs),
    },
  )
  assertActive(signal)
  if (!snapshot || !isNativePath(snapshot.path, platform) || typeof snapshot.cleanup !== 'function') {
    await cleanupSnapshot(snapshot, exitTimeoutMs)
    throw createRuntimeError(invalidSignatureReason)
  }
  try {
    const signatureValid = await runStage(
      (stageSignal) => verifySignature(snapshot.path, {
        env,
        platform,
        signal: stageSignal,
        timeoutMs,
      }),
      { signal, timeoutMs, timeoutReason: invalidSignatureReason },
    )
    assertActive(signal)
    return { snapshot, signatureValid }
  } catch (error) {
    await cleanupSnapshot(snapshot, exitTimeoutMs)
    throw error
  }
}

export async function spawnCodexRuntimeStage({
  executablePath,
  executableSnapshot,
  configured,
  version,
  cwd,
  env,
  platform,
  spawnImpl,
  terminate,
  childEnvironment,
  createObserver,
  onFatal,
  onSpawned,
  performHandshake,
  handshakeTimeoutMs,
  signal,
  assertActive,
  createRuntimeError,
  spawnFailedReason,
  processExitedReason,
}) {
  let child
  try {
    child = spawnImpl(executablePath, ['app-server'], {
      cwd,
      env: childEnvironment(env, platform),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: true,
    })
  } catch {
    throw createRuntimeError(spawnFailedReason)
  }
  const runtime = {
    child,
    configured,
    version,
    ready: false,
    closed: false,
    disposing: null,
    fatalHandling: null,
    phase: 'starting',
    terminate,
    observer: null,
    executableSnapshot,
  }
  onSpawned(runtime)
  runtime.observer = createObserver(child, { onFatal: (reason) => onFatal(runtime, reason) })
  await performHandshake(runtime, { timeoutMs: handshakeTimeoutMs, signal })
  assertActive(signal)
  if (runtime.observer.fatalReason || runtime.observer.exited) {
    throw createRuntimeError(runtime.observer.fatalReason || processExitedReason)
  }
  return runtime
}

export async function readCodexVersionStage({
  executablePath,
  signal,
  env,
  platform,
  timeoutMs,
  readVersion,
  runStage,
  assertActive,
  invalidVersionReason,
}) {
  const version = await runStage(
    (stageSignal) => readVersion(executablePath, {
      env,
      platform,
      signal: stageSignal,
      timeoutMs,
    }),
    { signal, timeoutMs, timeoutReason: invalidVersionReason },
  )
  assertActive(signal)
  return version
}
