# Windows desktop releases

`npm run desktop:dist` builds the web app, validates the Electron security boundary, and writes an NSIS installer plus `latest.yml` to `release/`.

Desktop data lives under Electron's per-user `userData/server-data` directory. Uninstalling the app does not delete that directory. The desktop runtime binds only to `127.0.0.1:5180` by default; set `GUGO_DESKTOP_PORT` to another unused port when required.

## Media sidecars

The Windows installer must contain both `ffmpeg.exe` and `ffprobe.exe`. They are not committed to Git. Before `electron-builder` runs, `npm run desktop:media-sidecars` validates and stages them as `resources/bin/ffmpeg.exe` and `resources/bin/ffprobe.exe`; `electron-builder.yml` then copies them to the installed app's `resources/bin`, which is the location read by `process.resourcesPath` at runtime.

The staging command uses an already staged pair first. Otherwise it reads `GUGO_FFMPEG_PATH` and `GUGO_FFPROBE_PATH`, then searches `PATH`. Both executables must pass their respective `-version` check or packaging stops. A reproducible release should point both variables at the reviewed binaries chosen by the distributor:

```powershell
$env:GUGO_FFMPEG_PATH = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:GUGO_FFPROBE_PATH = 'C:\Tools\ffmpeg\bin\ffprobe.exe'
npm run desktop:dist
```

The binaries remain ignored build artifacts. Keep the exact upstream version, download URL, checksum, license configuration, and any required source offer/notices with the release record.

## Publish an update

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Merge the fully verified release commit into `main`.
3. Configure the required signing secret and publisher variable described below.
4. Create the matching tag from the merged `main` history, such as `v0.10.1`, and push it.

The Release workflow builds on Windows and publishes the installer, block map, `latest.yml`, browser archive, and `SHA256SUMS.txt` to GitHub Releases. Installed apps remain local-first: they check and download only after the user explicitly chooses that action, and ask again before restarting to install it.

Configure the `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` GitHub secrets with a timestamp-capable Windows code-signing certificate, then set the non-secret repository variable `WINDOWS_PUBLISHER_NAME` to that certificate's exact publisher/common name before creating a production tag. The Release workflow uses `desktop:package:signed`, which enables electron-builder's `forceCodeSigning` mode. It then requires valid, timestamped Authenticode signatures from the same certificate on both the installer and packaged `Gugo.exe`, requires the signer to match `WINDOWS_PUBLISHER_NAME`, and verifies that packaged `app-update.yml` contains the same publisher name used by electron-updater. Unsigned local builds still work through `desktop:package`, but cannot pass the production Release workflow.

`npm run desktop:publish` intentionally exits with an error so a local command cannot bypass CI, signing verification, checksums, or provenance. The workflow rejects tags whose commit is not reachable from `origin/main`, and serializes runs for the same tag so tag-push and manual dispatch cannot race while updating draft assets. Publication uses GitHub's REST and Release Upload APIs with the workflow-scoped `GITHUB_TOKEN`; it does not depend on the GitHub CLI or a separately supplied personal access token. The publisher resolves the remote tag to the exact checked-out commit before creating, mutating, and publishing a Release. A new Release is always created as a draft. A resumed draft has only expected conflicting asset names deleted and re-uploaded; any unexpected asset fails closed for manual review. The complete remote asset set, names, and byte sizes are read back from GitHub before the draft is published. Any tag drift, upload, or verification failure leaves the Release as a draft. A published GitHub Release remains immutable and cannot be rebuilt or overwritten for the same tag.

Each workflow run also publishes GitHub build provenance for the browser archive, installer, block map, updater metadata, and checksum manifest. A downloaded release can be checked independently:

```powershell
$release = Invoke-RestMethod `
  -Uri 'https://api.github.com/repos/lichangjiang932-ship-it/Gugo/releases/latest' `
  -Headers @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'Gugo-release-verifier' }
$version = $release.tag_name.TrimStart('v')
$installer = ".\Gugo-Setup-$version-x64.exe"
Get-FileHash -Algorithm SHA256 -LiteralPath $installer
Get-AuthenticodeSignature -LiteralPath $installer | Format-List Status,SignerCertificate
gh attestation verify $installer --repo lichangjiang932-ship-it/Gugo
```

Compare the reported file hash with the matching line in `SHA256SUMS.txt`. Set `$version` explicitly when verifying a release other than the latest one.
