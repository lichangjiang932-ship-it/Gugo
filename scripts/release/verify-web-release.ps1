param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$version = node -p "require('./package.json').version"
$packageDirectoryName = "gugo-$version-web"
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$verificationRoot = Join-Path $temporaryRoot "gugo-web-release-$version"
$packageRoot = Join-Path $verificationRoot $packageDirectoryName
$dataRoot = Join-Path $verificationRoot 'data'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$server = $null
$locationPushed = $false

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
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'resources/licenses/LGPL-3.0.txt'))) {
  throw 'The Web release does not contain resources/licenses/LGPL-3.0.txt'
}

try {
  Push-Location $packageRoot
  $locationPushed = $true
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }

  $env:SERVER_HOST = '127.0.0.1'
  $env:SERVER_PORT = "$port"
  $env:APP_DATA_DIR = $dataRoot
  $env:NODE_ENV = 'production'
  $server = Start-Process -FilePath node -ArgumentList 'server/start.js' -WorkingDirectory $packageRoot -PassThru -WindowStyle Hidden

  $healthy = $false
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    if ($server.HasExited) {
      throw "The Web release server exited with code $($server.ExitCode)"
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
  if (-not $healthy) { throw 'The Web release did not become healthy' }
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
