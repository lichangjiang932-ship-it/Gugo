import { windowsWorkerStartupMarker } from './windowsTreeKillStartup.js'
import { windowsTreeKillNativeSource } from './windowsTreeKillNativeSource.js'

export function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim()
  return systemRoot ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

export function windowsTreeKillWorkerBootstrapScript() {
  return `
$ErrorActionPreference = 'Stop'
${windowsWorkerStartupMarker('bootstrap_entered')}
$payload = [Console]::In.ReadLine()
if ([String]::IsNullOrWhiteSpace($payload)) {
  throw 'Windows process-tree worker payload is missing.'
}
${windowsWorkerStartupMarker('payload_received')}
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
${windowsWorkerStartupMarker('payload_decoded')}
& ([ScriptBlock]::Create($source))
`.trim()
}

export function windowsTreeKillWorkerScript() {
  return `
$ErrorActionPreference = 'Stop'
${windowsWorkerStartupMarker('worker_entered')}
$nativeSource = @'
${windowsTreeKillNativeSource()}
'@
${windowsWorkerStartupMarker('utility_import_begin')}
# The isolation guard must not autoload a namesake module from the caller's
# PSModulePath. Resolve this dependency only from the running system host.
$utilityPath = [IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')
$utility = Microsoft.PowerShell.Core\\Import-Module -Name $utilityPath -PassThru -ErrorAction Stop
$addType = $utility.ExportedCmdlets['Add-Type']
if ($null -eq $addType) { throw 'The system PowerShell Add-Type cmdlet is unavailable.' }
${windowsWorkerStartupMarker('utility_import_end')}
${windowsWorkerStartupMarker('add_type_begin')}
$null = & $addType -TypeDefinition $nativeSource
${windowsWorkerStartupMarker('add_type_end')}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Out.WriteLine("READY" + [char]9 + "2")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split([char]9)
  if ($parts.Length -lt 3 -or [string]::IsNullOrWhiteSpace($parts[1])) { continue }
  $operation = $parts[0]
  $requestId = $parts[1]
  if (($operation -eq 'BIND' -or $operation -eq 'BIND_SEALED') -and $parts.Length -eq 5) {
    $rootPid = 0
    $identityCutoffUnixMs = 0L
    $valid = [int]::TryParse($parts[3], [ref]$rootPid) -and [long]::TryParse($parts[4], [ref]$identityCutoffUnixMs)
    $bound = $valid -and [GugoProcessTreeNative]::Bind($parts[2], $rootPid, $identityCutoffUnixMs, $operation -eq 'BIND_SEALED')
    [GugoProcessTreeNative]::WriteResponse($requestId, $bound)
    continue
  }
  if ($operation -eq 'KILL' -and $parts.Length -eq 4) {
    $timeoutMs = 0
    if (-not [int]::TryParse($parts[3], [ref]$timeoutMs)) {
      [GugoProcessTreeNative]::WriteResponse($requestId, $false)
      continue
    }
    if (-not [GugoProcessTreeNative]::QueueKill($requestId, $parts[2], $timeoutMs)) {
      [GugoProcessTreeNative]::WriteResponse($requestId, $false)
    }
    continue
  }
  if ($operation -eq 'RELEASE' -and $parts.Length -eq 3) {
    [GugoProcessTreeNative]::WriteResponse($requestId, [GugoProcessTreeNative]::Release($parts[2]))
    continue
  }
  [GugoProcessTreeNative]::WriteResponse($requestId, $false)
}
`.trim()
}

export function windowsTreeKillWorkerPayload() {
  return Buffer.from(windowsTreeKillWorkerScript(), 'utf8').toString('base64')
}

export function windowsTreeKillWorkerArgs() {
  // Keep CreateProcess far below Windows' 32,767-character command-line
  // limit. The full worker arrives as the first stdin frame.
  const encoded = Buffer.from(windowsTreeKillWorkerBootstrapScript(), 'utf16le').toString('base64')
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}
