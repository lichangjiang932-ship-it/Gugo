import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { spawnSync } from 'node:child_process'

import { MEDIA_TOOL_SPECS, dispatchMediaTool } from '../server/adapters/mediaTools.js'

function configuredCommand(envName, fallback) {
  const configured = String(process.env[envName] || '').trim()
  return configured || fallback
}

function commandAvailable(command, versionArg) {
  const result = spawnSync(command, [versionArg], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  })
  return !result.error && result.status === 0
}

const ffmpegCommand = configuredCommand(
  'GUGO_FFMPEG_PATH',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
)
const ffprobeCommand = configuredCommand(
  'GUGO_FFPROBE_PATH',
  process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
)
const integrationAvailable = commandAvailable(ffmpegCommand, '-version')
  && commandAvailable(ffprobeCommand, '-version')

function assertOutputContract(result, expectedPath) {
  assert.equal(result.path, expectedPath)
  assert.equal(result.output_path, expectedPath)
  assert.equal(result.scope, 'workspace')
  assert.deepEqual(result.changedPaths, [expectedPath])
}

const savedEnv = {
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}

let workspace

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-media-tools-'))
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'

  fs.writeFileSync(path.join(workspace, 'dummy.bin'), Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(path.join(workspace, 'already.mp4'), Buffer.from([9, 8, 7]))
  if (!integrationAvailable) return

  const fixture = path.join(workspace, 'fixture.mp4')
  const generated = spawnSync(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=160x120:rate=10:duration=1',
    '-c:v', 'mpeg4',
    '-pix_fmt', 'yuv420p',
    fixture,
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message)
  assert.ok(fs.statSync(fixture).size > 0)

  const avFixture = path.join(workspace, 'fixture-av.mp4')
  const generatedAv = spawnSync(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=160x120:rate=10:duration=2',
    '-f', 'lavfi',
    '-i', 'sine=frequency=660:sample_rate=44100:duration=2',
    '-shortest',
    '-c:v', 'mpeg4',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    avFixture,
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(generatedAv.status, 0, generatedAv.stderr || generatedAv.error?.message)
  assert.ok(fs.statSync(avFixture).size > 0)

  const alternateFixture = path.join(workspace, 'fixture-alternate.mp4')
  const generatedAlternate = spawnSync(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=128x96:rate=10:duration=1',
    '-c:v', 'mpeg4',
    '-pix_fmt', 'yuv420p',
    alternateFixture,
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(generatedAlternate.status, 0, generatedAlternate.stderr || generatedAlternate.error?.message)
  assert.ok(fs.statSync(alternateFixture).size > 0)

  fs.writeFileSync(path.join(workspace, "字幕 one's.srt"), [
    '1',
    '00:00:00,000 --> 00:00:01,500',
    'Burned in subtitle',
    '',
  ].join('\n'), 'utf8')

  const audioFixture = path.join(workspace, 'fixture.wav')
  const generatedAudio = spawnSync(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'pcm_s16le',
    audioFixture,
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(generatedAudio.status, 0, generatedAudio.stderr || generatedAudio.error?.message)
  assert.ok(fs.statSync(audioFixture).size > 0)
})

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
})

test('MEDIA_TOOL_SPECS exposes probe and the bounded transform operation enum', () => {
  const names = MEDIA_TOOL_SPECS.map((spec) => spec?.function?.name)
  assert.deepEqual(names, ['media_probe', 'media_transform'])
  const transform = MEDIA_TOOL_SPECS.find((spec) => spec.function.name === 'media_transform')
  assert.deepEqual(transform.function.parameters.properties.operation.enum, [
    'trim',
    'transcode',
    'extract_frame',
    'extract_audio',
    'change_speed',
    'generate_gif',
    'add_subtitles',
    'concat',
    'adjust_audio',
    'denoise_audio',
  ])
  assert.equal(transform.function.parameters.properties.overwrite.default, false)
  assert.deepEqual(transform.function.parameters.properties.concat_mode.enum, ['copy', 'reencode'])
  assert.equal(transform.function.parameters.properties.speed.minimum, 0.25)
  assert.equal(transform.function.parameters.properties.speed.maximum, 4)
  assert.match(transform.function.parameters.properties.subtitle_path.description, /burned/i)
  const allowedFormats = transform.function.parameters.properties.format.enum
  assert.ok(allowedFormats.includes('mp4'))
  assert.ok(allowedFormats.includes('singlejpeg'))
  for (const unsafe of ['tee', 'hls', 'dash', 'segment', 'fifo', 'image2']) {
    assert.equal(allowedFormats.includes(unsafe), false)
  }
})

test('media_transform rejects unknown operations before starting a process', async () => {
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'arbitrary_command',
      input_path: 'dummy.bin',
      output_path: 'out.mp4',
    }),
    (error) => error?.code === 'MEDIA_INVALID_ARGUMENT',
  )
})

test('media_transform preserves an existing output unless overwrite is explicit', async () => {
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'transcode',
      input_path: 'dummy.bin',
      output_path: 'already.mp4',
    }),
    (error) => error?.code === 'MEDIA_OUTPUT_EXISTS' && error?.statusCode === 409,
  )
  assert.deepEqual([...fs.readFileSync(path.join(workspace, 'already.mp4'))], [9, 8, 7])
})

test('media_transform rejects streaming and multi-output muxers before creating any file', async () => {
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-media-outside-'))
  const sentinelPath = path.join(outsideDirectory, 'sentinel.txt')
  fs.writeFileSync(sentinelPath, 'unchanged', 'utf8')
  const outsideBefore = fs.readdirSync(outsideDirectory)

  try {
    for (const unsafeFormat of ['tee', 'hls', 'dash', 'segment', 'stream_segment', 'fifo', 'image2']) {
      await assert.rejects(
        () => dispatchMediaTool('media_transform', {
          operation: 'transcode',
          input_path: 'dummy.bin',
          output_path: `blocked-${unsafeFormat}`,
          format: unsafeFormat,
        }),
        (error) => error?.code === 'MEDIA_OUTPUT_MUXER_UNSAFE'
          && /多输出或流式 muxer/.test(error?.hint || ''),
      )
    }

    for (const unsafeExtension of ['m3u8', 'mpd']) {
      await assert.rejects(
        () => dispatchMediaTool('media_transform', {
          operation: 'transcode',
          input_path: 'dummy.bin',
          output_path: `blocked.${unsafeExtension}`,
        }),
        (error) => error?.code === 'MEDIA_OUTPUT_EXTENSION_UNSUPPORTED',
      )
    }

    await assert.rejects(
      () => dispatchMediaTool('media_transform', {
        operation: 'transcode',
        input_path: 'dummy.bin',
        output_path: 'blocked.mp4',
        format: 'mp4',
      }),
      (error) => error?.code === 'MEDIA_FORMAT_WITH_EXTENSION',
    )

    await assert.rejects(
      () => dispatchMediaTool('media_transform', {
        operation: 'transcode',
        input_path: 'dummy.bin',
        output_path: 'blocked-parent/playlist',
        format: 'hls',
      }),
      (error) => error?.code === 'MEDIA_OUTPUT_MUXER_UNSAFE',
    )

    assert.equal(fs.readdirSync(workspace).some((name) => name.startsWith('blocked')), false)
    assert.equal(fs.existsSync(path.join(workspace, 'blocked-parent')), false)
    assert.deepEqual(fs.readdirSync(outsideDirectory), outsideBefore)
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'unchanged')
  } finally {
    fs.rmSync(outsideDirectory, { recursive: true, force: true })
  }
})

test('media_probe returns ffprobe JSON for a real one-second fixture', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const result = await dispatchMediaTool('media_probe', {
    input_path: 'fixture.mp4',
    timeout_ms: 15_000,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(Array.isArray(result.probe.streams))
  assert.ok(result.probe.streams.some((stream) => stream.codec_type === 'video'))
  assert.ok(Number(result.probe.format?.duration) > 0)
})

test('media_transform trims a real fixture through an atomic temporary output', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'trim',
    input_path: 'fixture.mp4',
    output_path: 'trimmed.mp4',
    start_seconds: 0,
    duration_seconds: 0.5,
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  assertOutputContract(transformed, 'trimmed.mp4')
  assert.ok(transformed.bytes > 0)
  assert.ok(fs.statSync(path.join(workspace, 'trimmed.mp4')).size > 0)
  assert.equal(fs.readdirSync(workspace).some((name) => /\.tmp(?:\.|$)|\.concat\.txt$/.test(name)), false)

  const probe = spawnSync(ffprobeCommand, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path.join(workspace, 'trimmed.mp4'),
  ], { encoding: 'utf8', shell: false, timeout: 10_000, windowsHide: true })
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message)
  assert.ok(Number(probe.stdout.trim()) > 0)
})

test('media_transform extracts a real PNG frame', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'extract_frame',
    input_path: 'fixture.mp4',
    output_path: 'frame.png',
    at_seconds: 0.2,
    width: 80,
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  const bytes = fs.readFileSync(path.join(workspace, 'frame.png'))
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(fs.readdirSync(workspace).some((name) => /\.tmp(?:\.|$)|\.concat\.txt$/.test(name)), false)
})

test('media_transform extracts only the selected audio stream from video', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'extract_audio',
    input_path: 'fixture-av.mp4',
    output_path: 'extracted.mp3',
    audio_stream_index: 0,
    audio_codec: 'libmp3lame',
    audio_bitrate: '96k',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  const probe = await dispatchMediaTool('media_probe', { input_path: 'extracted.mp3' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.ok(probe.probe.streams.some((stream) => stream.codec_type === 'audio'))
  assert.equal(probe.probe.streams.some((stream) => stream.codec_type === 'video'), false)
})

test('media_transform permits an allowlisted explicit muxer only for an extensionless output', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'extract_audio',
    input_path: 'fixture-av.mp4',
    output_path: 'extensionless-audio',
    format: 'mp3',
    audio_codec: 'libmp3lame',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  assertOutputContract(transformed, 'extensionless-audio')
  const output = fs.readFileSync(path.join(workspace, 'extensionless-audio'))
  assert.ok(output.length > 0)
  const probe = await dispatchMediaTool('media_probe', { input_path: 'extensionless-audio' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.equal(probe.probe.format?.format_name, 'mp3')
})

test('extract_audio returns a localized hint when the input has no audio stream', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'extract_audio',
    input_path: 'fixture.mp4',
    output_path: 'missing-audio.mp3',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, false)
  assert.equal(transformed.code, 'MEDIA_PROCESS_FAILED')
  assert.match(transformed.error, /^提取音频失败/)
  assert.match(transformed.hint, /audio_stream_index/)
  assert.equal(fs.existsSync(path.join(workspace, 'missing-audio.mp3')), false)
})

test('media_transform changes video and audio speed together', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'change_speed',
    input_path: 'fixture-av.mp4',
    output_path: 'double-speed.mp4',
    speed: 4,
    video_codec: 'mpeg4',
    audio_codec: 'aac',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  const probe = await dispatchMediaTool('media_probe', { input_path: 'double-speed.mp4' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.ok(probe.probe.streams.some((stream) => stream.codec_type === 'video'))
  assert.ok(probe.probe.streams.some((stream) => stream.codec_type === 'audio'))
  assert.ok(Number(probe.probe.format?.duration) > 0.4)
  assert.ok(Number(probe.probe.format?.duration) < 0.7)
})

test('change_speed handles audio-only input and chains the lower atempo bound', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'change_speed',
    input_path: 'fixture.wav',
    output_path: 'quarter-speed.wav',
    speed: 0.25,
    audio_codec: 'pcm_s16le',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  const probe = await dispatchMediaTool('media_probe', { input_path: 'quarter-speed.wav' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.equal(probe.probe.streams.some((stream) => stream.codec_type === 'video'), false)
  assert.ok(Number(probe.probe.format?.duration) > 3.8)
  assert.ok(Number(probe.probe.format?.duration) < 4.2)
})

test('media_transform generates a palette-optimized GIF with bounded duration and width', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'generate_gif',
    input_path: 'fixture.mp4',
    output_path: 'preview.gif',
    start_seconds: 0.1,
    duration_seconds: 0.6,
    fps: 8,
    width: 96,
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  const bytes = fs.readFileSync(path.join(workspace, 'preview.gif'))
  assert.match(bytes.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/)
  const probe = await dispatchMediaTool('media_probe', { input_path: 'preview.gif' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.equal(probe.probe.streams[0]?.width, 96)
})

test('media_transform burns SRT subtitles using a safe temporary name', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'add_subtitles',
    input_path: 'fixture-av.mp4',
    subtitle_path: "字幕 one's.srt",
    output_path: 'subtitled.mp4',
    video_codec: 'mpeg4',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  assertOutputContract(transformed, 'subtitled.mp4')
  assert.ok(fs.statSync(path.join(workspace, 'subtitled.mp4')).size > 0)
  assert.equal(fs.readdirSync(workspace).some((name) => /\.subtitles\.(?:srt|ass)$/.test(name)), false)
  const probe = await dispatchMediaTool('media_probe', { input_path: 'subtitled.mp4' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.ok(probe.probe.streams.some((stream) => stream.codec_type === 'video'))
})

test('media_transform concat uses an escaped temporary list and cleans it up', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  fs.copyFileSync(path.join(workspace, 'fixture.mp4'), path.join(workspace, "segment one's.mp4"))
  fs.copyFileSync(path.join(workspace, 'fixture.mp4'), path.join(workspace, 'segment two.mp4'))

  const transformed = await dispatchMediaTool('media_transform', {
    operation: 'concat',
    input_paths: ["segment one's.mp4", 'segment two.mp4'],
    output_path: 'joined.mp4',
    timeout_ms: 15_000,
  })

  assert.equal(transformed.ok, true, JSON.stringify(transformed))
  assert.ok(fs.statSync(path.join(workspace, 'joined.mp4')).size > 0)
  assert.equal(fs.readdirSync(workspace).some((name) => /\.concat\.txt$/.test(name)), false)

  const probe = spawnSync(ffprobeCommand, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path.join(workspace, 'joined.mp4'),
  ], { encoding: 'utf8', shell: false, timeout: 10_000, windowsHide: true })
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message)
  assert.ok(Number(probe.stdout.trim()) > 1)
})

test('concat reports an actionable Chinese hint for incompatible copy and can reencode', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 45_000,
}, async () => {
  const copyResult = await dispatchMediaTool('media_transform', {
    operation: 'concat',
    input_paths: ['fixture.mp4', 'fixture-alternate.mp4'],
    output_path: 'incompatible-copy.mp4',
    timeout_ms: 15_000,
  })

  assert.equal(copyResult.ok, false)
  assert.equal(copyResult.code, 'MEDIA_CONCAT_INCOMPATIBLE')
  assert.match(copyResult.error, /无法直接无损拼接/)
  assert.match(copyResult.hint, /concat_mode="reencode"/)
  assert.equal(fs.existsSync(path.join(workspace, 'incompatible-copy.mp4')), false)

  const reencoded = await dispatchMediaTool('media_transform', {
    operation: 'concat',
    concat_mode: 'reencode',
    input_paths: ['fixture.mp4', 'fixture-alternate.mp4'],
    output_path: 'reencoded-concat.mp4',
    video_codec: 'mpeg4',
    timeout_ms: 30_000,
  })

  assert.equal(reencoded.ok, true, JSON.stringify(reencoded))
  const probe = await dispatchMediaTool('media_probe', { input_path: 'reencoded-concat.mp4' })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.equal(probe.probe.streams.find((stream) => stream.codec_type === 'video')?.width, 160)
  assert.ok(Number(probe.probe.format?.duration) > 1.8)
})

test('media_transform transcodes video, adjusts volume, and denoises audio with bounded arguments', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const transcoded = await dispatchMediaTool('media_transform', {
    operation: 'transcode',
    input_path: 'fixture.mp4',
    output_path: 'transcoded.mkv',
    video_codec: 'mpeg4',
    timeout_ms: 15_000,
  })
  assert.equal(transcoded.ok, true, JSON.stringify(transcoded))

  const adjusted = await dispatchMediaTool('media_transform', {
    operation: 'adjust_audio',
    input_path: 'fixture.wav',
    output_path: 'adjusted.wav',
    volume: 0.5,
    timeout_ms: 15_000,
  })
  assert.equal(adjusted.ok, true, JSON.stringify(adjusted))

  const denoised = await dispatchMediaTool('media_transform', {
    operation: 'denoise_audio',
    input_path: 'fixture.wav',
    output_path: 'denoised.wav',
    noise_reduction_db: 14,
    noise_floor_db: -55,
    timeout_ms: 15_000,
  })
  assert.equal(denoised.ok, true, JSON.stringify(denoised))

  const [videoProbe, audioProbe, denoisedProbe] = await Promise.all([
    dispatchMediaTool('media_probe', { input_path: 'transcoded.mkv' }),
    dispatchMediaTool('media_probe', { input_path: 'adjusted.wav' }),
    dispatchMediaTool('media_probe', { input_path: 'denoised.wav' }),
  ])
  assert.equal(videoProbe.ok, true, JSON.stringify(videoProbe))
  assert.ok(videoProbe.probe.streams.some((stream) => stream.codec_type === 'video'))
  assert.equal(audioProbe.ok, true, JSON.stringify(audioProbe))
  assert.ok(audioProbe.probe.streams.some((stream) => stream.codec_type === 'audio'))
  assert.equal(denoisedProbe.ok, true, JSON.stringify(denoisedProbe))
  assert.ok(denoisedProbe.probe.streams.some((stream) => stream.codec_type === 'audio'))
})

test('media_transform validates denoise parameters before starting ffmpeg', async () => {
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'denoise_audio',
      input_path: 'dummy.bin',
      output_path: 'invalid-denoise.wav',
      noise_reduction_db: 100,
    }),
    (error) => error?.code === 'MEDIA_INVALID_ARGUMENT'
      && /noise_reduction_db/.test(error?.message || ''),
  )
})

test('media_transform validates new operation parameters before starting ffmpeg', async () => {
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'extract_audio',
      input_path: 'dummy.bin',
      output_path: 'invalid-audio.mp3',
      audio_stream_index: 0.5,
    }),
    (error) => error?.code === 'MEDIA_INVALID_ARGUMENT' && /整数/.test(error?.message || ''),
  )
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'change_speed',
      input_path: 'dummy.bin',
      output_path: 'invalid-speed.mp4',
      speed: 5,
    }),
    (error) => error?.code === 'MEDIA_INVALID_ARGUMENT' && /speed/.test(error?.message || ''),
  )
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'generate_gif',
      input_path: 'dummy.bin',
      output_path: 'too-long.gif',
      duration_seconds: 121,
    }),
    (error) => error?.code === 'MEDIA_INVALID_ARGUMENT' && /duration_seconds/.test(error?.message || ''),
  )
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'add_subtitles',
      input_path: 'dummy.bin',
      subtitle_path: 'dummy.bin',
      output_path: 'invalid-subtitles.mp4',
    }),
    (error) => error?.code === 'MEDIA_SUBTITLE_FORMAT_UNSUPPORTED',
  )
  await assert.rejects(
    () => dispatchMediaTool('media_transform', {
      operation: 'concat',
      concat_mode: 'unsafe',
      input_paths: ['dummy.bin', 'already.mp4'],
      output_path: 'invalid-concat.mp4',
    }),
    (error) => error?.code === 'MEDIA_INVALID_ARGUMENT' && /concat_mode/.test(error?.message || ''),
  )
})

test('a pre-aborted transform leaves no output or temporary file', {
  skip: !integrationAvailable && 'ffmpeg/ffprobe are not available on the system PATH',
  timeout: 30_000,
}, async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await dispatchMediaTool('media_transform', {
    operation: 'transcode',
    input_path: 'fixture.mp4',
    output_path: 'cancelled.mp4',
    video_codec: 'mpeg4',
  }, { signal: controller.signal })

  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.equal(fs.existsSync(path.join(workspace, 'cancelled.mp4')), false)
  assert.equal(fs.readdirSync(workspace).some((name) => /cancelled.*\.tmp/.test(name)), false)
})
