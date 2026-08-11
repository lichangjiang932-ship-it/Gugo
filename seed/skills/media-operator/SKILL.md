---
name: media-operator
description: >
  Process audio or video files: inspect streams, trim, transcode, extract audio
  or frames, change speed, generate GIFs, burn subtitles, concatenate clips, or
  adjust volume/noise. Use for 剪辑、提取音频、变速、GIF、字幕、拼接、降噪、格式转换 and other media tasks.
---

# Media Operator

Use only tools actually exposed in the current turn.

1. Call `media_probe` before transforming unfamiliar input. Confirm duration, streams, codecs, dimensions, and sample rate.
2. Call `media_transform` with one explicit operation. Use authorized file paths; do not put binary/base64 content in tool arguments.
3. Keep `overwrite` false unless the user explicitly asked to replace an existing file. Prefer a new output path and preserve the source.
4. After writing, call `media_probe` on the result and compare duration/streams with the request.
5. Use `extract_audio` for audio-only output, `change_speed` for synchronized video/audio speed, `generate_gif` for a bounded palette-optimized GIF, and `add_subtitles` to burn an authorized SRT/ASS file into video pixels.
6. For concatenation, keep inputs in the requested order. Start with `concat_mode="copy"` only when stream parameters match; if the tool reports `MEDIA_CONCAT_INCOMPATIBLE`, retry once with `concat_mode="reencode"` when quality loss is acceptable.
7. For noise reduction, use `operation="denoise_audio"`; start with the default FFT reduction and only raise `noise_reduction_db` when the user asks for stronger cleanup. Probe the output because aggressive filtering can damage speech or music.
8. If the runtime reports FFmpeg unavailable, report its concrete configuration hint once. Do not loop on the same call.

These path-based tools intentionally bypass the small UTF-8 `read_file` channel while retaining directory authorization and media-specific limits.
