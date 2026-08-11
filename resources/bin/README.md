# Desktop media sidecars

The Windows installer bundles `ffmpeg.exe` and `ffprobe.exe` from this directory into Electron's `resources/bin` directory. The executables are build artifacts and are intentionally not committed.

Run `npm run desktop:media-sidecars` on Windows before packaging. The command validates existing files first, otherwise copies the executables selected by `GUGO_FFMPEG_PATH` and `GUGO_FFPROBE_PATH`, or found on `PATH`.

Distributors are responsible for choosing an FFmpeg build whose license and enabled codecs are suitable for their distribution, and for providing the corresponding notices/source offer when required.
