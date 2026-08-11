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
2. Commit and push the change.
3. Create and push the matching tag, such as `v0.10.1`.

The Release workflow builds on Windows and publishes the installer, block map, and `latest.yml` to GitHub Releases. Installed apps check shortly after startup and every 15 minutes, download a newer release in the background, and ask before restarting to install it.

For public distribution, configure the `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` GitHub secrets with a Windows code-signing certificate. Unsigned local builds work, but Windows SmartScreen may warn users.
