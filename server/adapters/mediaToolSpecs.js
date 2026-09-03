import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TRANSFORM_TIMEOUT_MS,
  EXPLICIT_SINGLE_FILE_MUXERS,
  MAX_CONCAT_INPUTS,
  MAX_GIF_DURATION_SECONDS,
  MAX_PLAYBACK_SPEED,
  MAX_TIMEOUT_MS,
  MEDIA_OPERATIONS,
  MIN_PLAYBACK_SPEED,
} from './mediaToolRuntime.js'

export const MEDIA_TOOL_SPECS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'media_probe',
      description: 'Inspect an authorized audio or video file with ffprobe and return structured JSON metadata. The input may be a workspace path, an authorized absolute path, or a managed attachment URI.',
      parameters: {
        type: 'object',
        properties: {
          input_path: { type: 'string', description: 'Authorized media path or managed attachment URI.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_PROBE_TIMEOUT_MS },
        },
        required: ['input_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_transform',
      description: 'Transform authorized media with ffmpeg: trim/transcode, extract audio or frames, change playback speed, generate a palette-optimized GIF, burn in external SRT/ASS subtitles, concatenate, adjust volume, or denoise audio. Writes to a same-directory temporary file and commits only a complete output. Existing files are preserved unless overwrite=true.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: MEDIA_OPERATIONS },
          input_path: { type: 'string', description: 'Single media input used by every operation except concat.' },
          input_paths: {
            type: 'array',
            minItems: 2,
            maxItems: MAX_CONCAT_INPUTS,
            items: { type: 'string' },
            description: 'Ordered authorized inputs used by concat.',
          },
          subtitle_path: { type: 'string', description: 'Authorized UTF-8 .srt or .ass subtitle path used by add_subtitles. Subtitles are burned into video pixels.' },
          output_path: { type: 'string', description: 'Authorized output path. Must differ from all inputs.' },
          overwrite: { type: 'boolean', default: false },
          start_seconds: { type: 'number', minimum: 0, default: 0, description: 'Start time used by trim and generate_gif.' },
          duration_seconds: { type: 'number', exclusiveMinimum: 0, description: `Required duration for trim and generate_gif; GIF duration is limited to ${MAX_GIF_DURATION_SECONDS} seconds.` },
          at_seconds: { type: 'number', minimum: 0, default: 0, description: 'Frame extraction timestamp.' },
          audio_stream_index: { type: 'integer', minimum: 0, maximum: 63, default: 0, description: 'Zero-based audio stream selected by extract_audio.' },
          speed: { type: 'number', minimum: MIN_PLAYBACK_SPEED, maximum: MAX_PLAYBACK_SPEED, description: 'Required playback speed multiplier for change_speed. Video timestamps and audio tempo are both adjusted.' },
          fps: { type: 'number', minimum: 1, maximum: 60, default: 12, description: 'Frame rate used by generate_gif.' },
          concat_mode: {
            type: 'string',
            enum: ['copy', 'reencode'],
            default: 'copy',
            description: 'copy is fast and lossless but requires matching stream parameters; reencode normalizes video canvas and audio sampling before concatenating.',
          },
          volume: { type: 'number', minimum: 0, maximum: 10, description: 'Required audio volume multiplier.' },
          noise_reduction_db: { type: 'number', minimum: 0.01, maximum: 40, default: 12, description: 'FFT denoising strength for denoise_audio, in dB.' },
          noise_floor_db: { type: 'number', minimum: -80, maximum: -20, default: -50, description: 'Expected noise floor for denoise_audio, in dB.' },
          width: { type: 'integer', minimum: 1, maximum: 16384, description: 'Output width used by extract_frame or generate_gif.' },
          height: { type: 'integer', minimum: 1, maximum: 16384 },
          video_codec: { type: 'string' },
          audio_codec: { type: 'string' },
          video_bitrate: { type: 'string' },
          audio_bitrate: { type: 'string' },
          format: {
            type: 'string',
            enum: Object.keys(EXPLICIT_SINGLE_FILE_MUXERS),
            description: 'Safe single-file ffmpeg muxer used only when output_path has no extension. Do not set format when output_path already has an extension. Streaming/multi-output muxers such as tee, hls, dash, segment, fifo, and image2 are forbidden.',
          },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TRANSFORM_TIMEOUT_MS },
        },
        required: ['operation', 'output_path'],
        anyOf: [
          { required: ['input_path'] },
          { required: ['input_paths'] },
        ],
      },
    },
  },
])
