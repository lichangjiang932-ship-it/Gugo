param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$version = [string](Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw 'The project package version is invalid'
}
$packageDirectoryName = "gugo-$version-web"
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$temporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
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
$originalEnvironment = [System.Environment]::GetEnvironmentVariables('Process')

# Keep only operating-system/tool-discovery inputs. In particular, do not pass
# deployment credentials, NODE_OPTIONS, custom persistence modules or npm config
# through to any verification subprocess, including dependency installation.
$inheritedEnvironmentKeys = @(
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE'
)
$verificationEnvironment = @{
  SERVER_HOST = '127.0.0.1'
  SERVER_PORT = "$port"
  NODE_ENV = 'production'
  APP_DATA_DIR = $dataRoot
  APP_DB_PATH = (Join-Path $dataRoot 'app.db')
  APP_CONFIG_PATH = (Join-Path $dataRoot 'runtime.json')
  ARTIFACT_DIR = (Join-Path $verificationRoot 'artifacts')
  WORKSPACE_ROOT = (Join-Path $verificationRoot 'workspace')
  TEMP = (Join-Path $verificationRoot 'tmp')
  TMP = (Join-Path $verificationRoot 'tmp')
  TMPDIR = (Join-Path $verificationRoot 'tmp')
  NPM_CONFIG_CACHE = (Join-Path $verificationRoot 'npm-cache')
  NPM_CONFIG_DEVDIR = (Join-Path $verificationRoot 'node-gyp')
  NPM_CONFIG_USERCONFIG = (Join-Path $verificationRoot 'npm-user.npmrc')
  NPM_CONFIG_GLOBALCONFIG = (Join-Path $verificationRoot 'npm-global.npmrc')
  GUGO_LOAD_DOTENV = '0'
  GUGO_PURE_LOCAL_MODE = '1'
  CODEX_PLUGIN_ROOTS = '[]'
  CODEX_APP_SERVER_ENABLED = '0'
  MCP_STDIO_ENABLED = '0'
}

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

try {
  if (Test-Path -LiteralPath $verificationRoot) {
    throw 'The Web release verification directory already exists; refusing to reuse it'
  }
  New-Item -ItemType Directory -Path $verificationRoot | Out-Null
  foreach ($directory in @(
    $dataRoot, $verificationEnvironment.ARTIFACT_DIR, $verificationEnvironment.WORKSPACE_ROOT,
    $verificationEnvironment.TEMP, $verificationEnvironment.NPM_CONFIG_CACHE,
    $verificationEnvironment.NPM_CONFIG_DEVDIR
  )) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
  foreach ($config in @($verificationEnvironment.NPM_CONFIG_USERCONFIG, $verificationEnvironment.NPM_CONFIG_GLOBALCONFIG)) {
    New-Item -ItemType File -Path $config | Out-Null
  }
  foreach ($key in $originalEnvironment.Keys) {
    if ($key -notin $inheritedEnvironmentKeys) {
      Remove-Item -LiteralPath "Env:$key" -ErrorAction Stop
    }
  }
  foreach ($entry in $verificationEnvironment.GetEnumerator()) {
    [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }

  tar -xzf $archive -C $verificationRoot
  if ($LASTEXITCODE -ne 0) { throw 'The Web release archive extraction failed' }
  foreach ($requiredFile in @(
    'dist/index.html', 'server/start.js', 'package-lock.json', 'THIRD_PARTY_NOTICES.md',
    'bin/yma-cli.js', 'docs/CLI.md', 'resources/licenses/LGPL-3.0.txt'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $requiredFile) -PathType Leaf)) {
      throw "The Web release does not contain $requiredFile"
    }
  }

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
  try {
    if ($server -and -not $server.HasExited) {
      Stop-Process -Id $server.Id -Force
      $server.WaitForExit()
    }
  } finally {
    try {
      if ($locationPushed) { Pop-Location }
    } finally {
      foreach ($key in [System.Environment]::GetEnvironmentVariables('Process').Keys) {
        if (-not $originalEnvironment.Contains($key)) {
          Remove-Item -LiteralPath "Env:$key" -ErrorAction Stop
        }
      }
      foreach ($entry in $originalEnvironment.GetEnumerator()) {
        [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
      }
    }
  }
}
