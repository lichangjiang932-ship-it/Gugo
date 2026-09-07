# Windows desktop releases

`npm run desktop:dist` builds the web app, validates the Electron security boundary, and writes an NSIS installer plus `latest.yml` to `release/`. It is a local build command, not permission to publish. Production releases use the version-bound signing policy described below.

Version 0.11.55 explicitly selects an **unsigned** Windows release. No signing certificate is being configured for this release. This accepts the absence of an Authenticode publisher identity; it does not declare the signing debt resolved.

Desktop data lives under Electron's per-user `userData/server-data` directory. Uninstalling the app does not delete that directory. The desktop runtime binds only to `127.0.0.1:5180` by default; set `GUGO_DESKTOP_PORT` to another unused port when required.

## Media sidecars

The Windows installer must contain both `ffmpeg.exe` and `ffprobe.exe`. They are not committed to Git. Before `electron-builder` runs, `npm run desktop:media-sidecars` validates and stages them as `resources/bin/ffmpeg.exe` and `resources/bin/ffprobe.exe`; `electron-builder.yml` then copies them to the installed app's `resources/bin`, which is the location read by `process.resourcesPath` at runtime.

The staging command uses an already staged pair first. Otherwise it reads `GUGO_FFMPEG_PATH` and `GUGO_FFPROBE_PATH`, then searches `PATH`. Both executables must pass their respective `-version` check or packaging stops. A reproducible release should point both variables at the reviewed binaries chosen by the distributor:

```powershell
$env:GUGO_FFMPEG_PATH = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:GUGO_FFPROBE_PATH = 'C:\Tools\ffmpeg\bin\ffprobe.exe'
npm run build
npm run desktop:package:unsigned
```

The binaries remain ignored build artifacts. Keep the exact upstream version, download URL, checksum, license configuration, and any required source offer/notices with the release record.

## Publish an update

1. Update `package.json`, `package-lock.json`, and the `version` in `scripts/release/policy.json` to the same semantic version. Review and explicitly select `windowsSigning: "signed"` or `"unsigned"` in that committed policy for every version bump.
2. For `signed`, configure the certificate and publisher described below. For `unsigned`, explicitly accept the publisher-identity and migration limitations; missing credentials are never a reason to change modes automatically.
3. Merge the fully verified release commit, including its policy, into `main`.
4. Create the matching tag from the merged `main` history, such as `v0.11.55`, and push it.

The Release workflow reads the checked-out policy and explicitly selects the matching build and verification path. A missing, invalid, or version-mismatched policy fails closed. The current policy binds `version: "0.11.55"` to `windowsSigning: "unsigned"`; a future version must have its own matching policy version. Neither unavailable secrets nor a failed signature check causes an automatic downgrade to unsigned.

Validate the checked-out policy before packaging:

```powershell
node scripts/release/releasePolicy.mjs
```

This read-only preflight also checks `RELEASE_TAG` when set and requires signing inputs when the policy selects `signed`. It does not build, upload, or prove that release artifacts have passed verification.

Both modes retain CI gates and publish the complete five-asset set: installer, block map, `latest.yml`, browser archive, and `SHA256SUMS.txt`. Each asset receives GitHub build provenance. Unsigned does not mean an unverified or partial upload, but those checks do not supply an Authenticode publisher identity.

### Unsigned path for 0.11.55

Use `npm run desktop:package:unsigned` for explicitly unsigned packaging. This path disables executable signing with `signExecutable: false`, while preserving the application icon and version resources. It does not disable resource editing as a shortcut to avoiding signing.

After packaging succeeds, verify the unsigned output from the repository root:

```powershell
powershell -NoProfile -File scripts/release/verify-windows-signing.ps1 -Mode unsigned
```

The verifier defaults to `release/` and reads the expected version from `package.json`. To inspect an isolated packaging output, append `-ReleaseDirectory <isolated-output-directory>`, replacing the placeholder with that existing directory's quoted path. It requires exactly the version-matched installer and checks the packaged `win-unpacked/Gugo.exe` beside it.

Both executables must have Authenticode status `NotSigned`, and the actual parsed `app-update.yml` metadata must not advertise a certificate publisher. An unexpectedly signed binary, an invalid signature, or an unverifiable signature state is not accepted as an unsigned build. Checksums, the complete asset set, provenance, and immutable publication remain required. This mode does not require `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, or `WINDOWS_PUBLISHER_NAME`. Merely passing configuration validation is not proof that an installer was built or verified.

### Signed path

For a version whose committed policy selects `signed`, configure `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` GitHub secrets with a timestamp-capable Windows code-signing certificate, then set the non-secret repository variable `WINDOWS_PUBLISHER_NAME` to that certificate's exact publisher/common name. The workflow uses `desktop:package:signed`, which enables electron-builder's `forceCodeSigning` mode. It requires valid, timestamped Authenticode signatures from the same certificate on both the installer and packaged `Gugo.exe`, pins the signer to `WINDOWS_PUBLISHER_NAME`, and verifies that packaged `app-update.yml` contains the same publisher name used by electron-updater. Missing credentials or any failed verification stops this path; it never falls back to unsigned.

For signed-policy output only, with `WINDOWS_PUBLISHER_NAME` set in the environment, run:

```powershell
powershell -NoProfile -File scripts/release/verify-windows-signing.ps1 -Mode signed
```

The same `-ReleaseDirectory` option supports an isolated output directory. Both signatures must be valid and timestamped, use the same certificate, and have the exact configured publisher/common name. The verifier uses `read-updater-publishers.mjs` and electron-updater's declared YAML parser to read actual publisher values: exactly one publisher must match the verified certificate name. A YAML comment containing that name cannot satisfy the check.

### Publication and independent checks

`npm run desktop:publish` intentionally exits with an error so a local command cannot bypass CI, the selected signing policy, checksums, or provenance. The workflow rejects tags whose commit is not reachable from `origin/main`, and serializes runs for the same tag so tag-push and manual dispatch cannot race while updating draft assets. Publication uses GitHub's REST and Release Upload APIs with the workflow-scoped `GITHUB_TOKEN`; it does not depend on the GitHub CLI or a separately supplied personal access token. The publisher resolves the remote tag to the exact checked-out commit before creating, mutating, and publishing a Release. A new Release is always created as a draft. A resumed draft has only expected conflicting asset names deleted and re-uploaded; any unexpected asset fails closed for manual review. The complete remote asset set, names, and byte sizes are read back from GitHub before the draft is published. Any tag drift, upload, or verification failure leaves the Release as a draft. A published GitHub Release remains immutable and cannot be rebuilt or overwritten for the same tag.

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

Compare the reported file hash with the matching line in `SHA256SUMS.txt`, and inspect the policy committed at the exact release tag. Expect `NotSigned` for the unsigned policy; a signed policy requires a valid timestamped signature and the expected publisher. Set `$version` explicitly when verifying a release other than the latest one. SHA-256/SHA-512 checksums check file integrity; GitHub attestations help audit build provenance. Neither is Authenticode, supplies an unsigned installer with a Windows publisher identity, or proves that a binary is harmless.

## Installation warnings and updater compatibility

Windows or SmartScreen may show an unknown-publisher or reputation warning for the unsigned installer. Do not disable SmartScreen, Windows protection, or an organization's security controls to suppress it. Review the exact release and independent checks above; if your policy requires signed applications, use an approved alternative or wait for a signed release.

Installed apps remain local-first: they check and download only after the user explicitly chooses that action, and ask again before restarting to install it. After SHA-512 validation and before committing a downloaded installer to the update cache or reporting it ready, the downloader calls the current `NsisUpdater.verifySignature` implementation and honors its configured publisher policy. Signature verification is not globally disabled for unsigned releases or migration.

A client correctly enforcing a signed publisher must reject an unsigned update. Moving such a client to 0.11.55 therefore requires an explicit manual installer migration after reviewing the unsigned-release risks and checks; repeatedly retrying automatic updates cannot make the publisher requirement match. Preserve the existing user-data directory and follow local security policy. The updated downloader only protects clients running that code: it cannot retroactively repair a previously distributed updater or establish trust for historical downloads.
