# Windows FFmpeg Sidecar Provenance

Gugo's Windows installer stages these binaries during release packaging from
exact dependencies in `package-lock.json`. The executables under
`resources/bin/` are build outputs and are intentionally ignored by Git.

The staging order is:

1. An explicit `GUGO_FFMPEG_PATH` or `GUGO_FFPROBE_PATH`.
2. The real `.path` exported by the corresponding locked npm wrapper.
3. An already staged file under `resources/bin/`.
4. A final `PATH` fallback for local development only.

Every selected file must execute successfully and identify itself through
`-version` before and after staging. Release runners therefore use the locked
package binary instead of a Chocolatey or other command shim.

## ffmpeg.exe

- Resolver: `@ffmpeg-installer/ffmpeg@1.1.0`
- Windows binary package: `@ffmpeg-installer/win32-x64@4.1.0`
- Package build identifier: `20181217-f22fcd4`
- Reported version: `N-92722-gf22fcd4483`
- SHA-256: `C8ABC49E7BE62DDE8E12972AF373959E0076A7B8DC8040EB45978E0608F8781E`
- Original build channel: [Zeranoe Windows 64-bit static build, as recorded by the immutable npm package](https://www.npmjs.com/package/@ffmpeg-installer/win32-x64/v/4.1.0)
- Corresponding FFmpeg source: [`f22fcd4483`](https://github.com/FFmpeg/FFmpeg/tree/f22fcd4483)
- License: GNU General Public License version 3 (`GPL-3.0.txt`)

## ffprobe.exe

- Resolver: `@ffprobe-installer/ffprobe@2.1.2`
- Windows binary package: `@ffprobe-installer/win32-x64@5.1.0`
- Package build identifier: `20230213-2296078`
- Reported version: `2023-02-13-git-2296078397-essentials_build-www.gyan.dev`
- SHA-256: `F28C4751E7367205267025AAF0FCFC921E34D9B7EDAA46BD9C8ABAF367FC9051`
- Original build channel: [Gyan.dev Windows builds](https://www.gyan.dev/ffmpeg/builds/)
- Corresponding FFmpeg source: [`2296078397`](https://github.com/FFmpeg/FFmpeg/tree/2296078397)
- License: GNU General Public License version 3 (`GPL-3.0.txt`)

Both executables report `--enable-gpl --enable-version3` in their build
configuration. The full GPLv3 license text is distributed in this directory.
