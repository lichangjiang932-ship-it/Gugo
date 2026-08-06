# Windows desktop releases

`npm run desktop:dist` builds the web app, validates the Electron security boundary, and writes an NSIS installer plus `latest.yml` to `release/`.

Desktop data lives under Electron's per-user `userData/server-data` directory. Uninstalling the app does not delete that directory. The desktop runtime binds only to `127.0.0.1:5180` by default; set `GUGO_DESKTOP_PORT` to another unused port when required.

## Publish an update

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Commit and push the change.
3. Create and push the matching tag, such as `v0.10.1`.

The Release workflow builds on Windows and publishes the installer, block map, and `latest.yml` to GitHub Releases. Installed apps check shortly after startup and every 15 minutes, download a newer release in the background, and ask before restarting to install it.

For public distribution, configure the `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` GitHub secrets with a Windows code-signing certificate. Unsigned local builds work, but Windows SmartScreen may warn users.
