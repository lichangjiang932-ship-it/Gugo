param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('signed', 'unsigned')]
  [string]$Mode,
  [string]$ReleaseDirectory = 'release',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Version) {
  $projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $Version = [string](Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw 'Invalid package version for Windows signing verification'
}
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$expectedInstallerName = "Gugo-Setup-$Version-x64.exe"
$installers = @(Get-ChildItem -LiteralPath $releaseRoot -Filter 'Gugo-Setup-*.exe' -File)
if ($installers.Count -ne 1 -or $installers[0].Name -cne $expectedInstallerName) {
  throw "Expected exactly one Windows installer named $expectedInstallerName"
}
$application = (Resolve-Path -LiteralPath (Join-Path $releaseRoot 'win-unpacked/Gugo.exe')).Path
$updateConfigPath = Join-Path $releaseRoot 'win-unpacked/resources/app-update.yml'
if (-not (Test-Path -LiteralPath $updateConfigPath -PathType Leaf)) { throw 'Packaged app-update.yml is missing' }
$publisherOutput = & node (Join-Path $PSScriptRoot 'read-updater-publishers.mjs') $updateConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Cannot parse packaged updater publisher metadata' }
$decodedPublisherNames = $publisherOutput | ConvertFrom-Json
[string[]]$publisherNames = @(foreach ($publisherName in $decodedPublisherNames) { [string]$publisherName })
$signerThumbprint = $null
$signerName = $null
foreach ($executable in @($installers[0].FullName, $application)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $executable
  if ($Mode -eq 'unsigned') {
    if ($signature.Status -ne 'NotSigned' -or $null -ne $signature.SignerCertificate) {
      throw "Explicit unsigned build is not cleanly NotSigned: $executable ($($signature.Status))"
    }
    continue
  }
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw "Executable signature is not valid: $executable ($($signature.Status))"
  }
  if ($null -eq $signature.TimeStamperCertificate) { throw "Executable signature has no trusted timestamp: $executable" }
  if ($null -eq $signerThumbprint) {
    $signerThumbprint = $signature.SignerCertificate.Thumbprint
    $signerName = $signature.SignerCertificate.GetNameInfo(
      [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false
    )
  } elseif ($signature.SignerCertificate.Thumbprint -ne $signerThumbprint) {
    throw "Packaged executables were signed by different certificates: $executable"
  }
}
if ($Mode -eq 'signed') {
  if ([string]::IsNullOrWhiteSpace($signerName) -or $signerName -cne $env:WINDOWS_PUBLISHER_NAME) {
    throw 'Signer does not match configured WINDOWS_PUBLISHER_NAME'
  }
  if ($publisherNames.Count -ne 1 -or $publisherNames[0] -cne $signerName) {
    throw 'Packaged updater publisherName does not match the verified signer'
  }
} elseif ($publisherNames.Count -ne 0) {
  throw 'Unsigned build must not advertise a certificate publisher in app-update.yml'
}
Write-Output "Verified $Mode Windows installer and application for $Version"
