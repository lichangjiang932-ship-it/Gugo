param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$version = node -p "require('./package.json').version"
$packageDirectoryName = "gugo-$version-web"
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$verificationRunId = [guid]::NewGuid().ToString('N')
$verificationRoot = Join-Path $temporaryRoot "gugo-web-release-$version-$verificationRunId"
$packageRoot = Join-Path $verificationRoot $packageDirectoryName
$dataRoot = Join-Path $verificationRoot 'data'
$serverStdoutPath = Join-Path $verificationRoot 'server.stdout.log'
$serverStderrPath = Join-Path $verificationRoot 'server.stderr.log'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$server = $null
$locationPushed = $false

function Read-ServerDiagnostics {
  $parts = @()
  foreach ($log in @(
    @{ Label = 'server stdout'; Path = $serverStdoutPath },
    @{ Label = 'server stderr'; Path = $serverStderrPath }
  )) {
    if (Test-Path -LiteralPath $log.Path) {
      $content = Get-Content -LiteralPath $log.Path -Raw -ErrorAction SilentlyContinue
      if (-not [string]::IsNullOrWhiteSpace($content)) {
        $parts += "$($log.Label):`n$content"
      }
    }
  }
  if ($parts.Count -eq 0) { return 'The Web release server produced no diagnostics.' }
  return ($parts -join "`n")
}

if (Test-Path -LiteralPath $verificationRoot) {
  Remove-Item -LiteralPath $verificationRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $verificationRoot | Out-Null
tar -xzf $archive -C $verificationRoot

if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'dist/index.html'))) {
  throw 'The Web release does not contain dist/index.html'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'server/start.js'))) {
  throw 'The Web release does not contain server/start.js'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'package-lock.json'))) {
  throw 'The Web release does not contain package-lock.json'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'THIRD_PARTY_NOTICES.md'))) {
  throw 'The Web release does not contain THIRD_PARTY_NOTICES.md'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'bin/yma-cli.js'))) {
  throw 'The Web release does not contain bin/yma-cli.js'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'docs/CLI.md'))) {
  throw 'The Web release does not contain docs/CLI.md'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'resources/licenses/LGPL-3.0.txt'))) {
  throw 'The Web release does not contain resources/licenses/LGPL-3.0.txt'
}

try {
  Push-Location $packageRoot
  $locationPushed = $true
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }

  $cliVersion = (& node 'bin/yma-cli.js' '--version' 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'The Web release CLI --version command failed' }
  if ($cliVersion -ne $version) {
    throw "The Web release CLI reported version '$cliVersion' instead of '$version'"
  }

  $cliHelp = (& node 'bin/yma-cli.js' '--help' 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'The Web release CLI --help command failed' }
  if ($cliHelp -notmatch '(?m)^Usage:' -or $cliHelp -notmatch 'gugo run') {
    throw 'The Web release CLI --help output is incomplete'
  }

  $env:SERVER_HOST = '127.0.0.1'
  $env:SERVER_PORT = "$port"
  $env:APP_DATA_DIR = $dataRoot
  $env:NODE_ENV = 'production'
  $server = Start-Process -FilePath node -ArgumentList 'server/start.js' -WorkingDirectory $packageRoot -RedirectStandardOutput $serverStdoutPath -RedirectStandardError $serverStderrPath -PassThru -WindowStyle Hidden

  $healthy = $false
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    if ($server.HasExited) {
      $server.WaitForExit()
      throw "The Web release server exited with code $($server.ExitCode)`n$(Read-ServerDiagnostics)"
    }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) { throw "The Web release did not become healthy`n$(Read-ServerDiagnostics)" }
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
    $server.WaitForExit()
  }
  if ($locationPushed) { Pop-Location }
  Remove-Item Env:SERVER_HOST -ErrorAction SilentlyContinue
  Remove-Item Env:SERVER_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:APP_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
}
