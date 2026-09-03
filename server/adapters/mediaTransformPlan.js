import {
  DEFAULT_TRANSFORM_TIMEOUT_MS,
  MAX_GIF_DURATION_SECONDS,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  finiteInteger,
  finiteNumber,
  normalizeTimeout,
  safeToken,
  toolError,
} from './mediaToolRuntime.js'

function codecArgs(args) {
  const result = []
  const videoCodec = safeToken(args.video_codec, 'video_codec')
  const audioCodec = safeToken(args.audio_codec, 'audio_codec')
  const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
  const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
  if (videoCodec) result.push('-c:v', videoCodec)
  if (audioCodec) result.push('-c:a', audioCodec)
  if (videoBitrate) result.push('-b:v', videoBitrate)
  if (audioBitrate) result.push('-b:a', audioBitrate)
  return result
}

export function concatMode(args) {
  const mode = String(args?.concat_mode || 'copy').trim().toLowerCase()
  if (!['copy', 'reencode'].includes(mode)) throw toolError('concat_mode 必须是 copy 或 reencode')
  return mode
}

function requireReencodingCodec(value, name) {
  const codec = safeToken(value, name)
  if (codec === 'copy') throw toolError(`${name}=copy 不能用于需要滤镜处理的操作`)
  return codec
}

function buildAtempoChain(speed) {
  const factors = []
  let remainder = speed
  while (remainder < 0.5 - Number.EPSILON) {
    factors.push(0.5)
    remainder /= 0.5
  }
  while (remainder > 2 + Number.EPSILON) {
    factors.push(2)
    remainder /= 2
  }
  factors.push(Number(remainder.toFixed(8)))
  return factors.map((factor) => `atempo=${factor}`).join(',')
}

function firstStream(metadata, type) {
  return metadata?.streams?.find((stream) => stream?.codec_type === type) || null
}

function parseFrameRate(value) {
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(value || ''))
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  const rate = numerator / denominator
  return rate > 0 && rate <= 240 ? rate : null
}

function streamCopySignature(metadata) {
  return (metadata?.streams || [])
    .filter((stream) => stream?.codec_type === 'video' || stream?.codec_type === 'audio')
    .map((stream) => stream.codec_type === 'video'
      ? {
          type: 'video',
          codec: stream.codec_name || null,
          profile: stream.profile || null,
          width: Number(stream.width) || null,
          height: Number(stream.height) || null,
          pixelFormat: stream.pix_fmt || null,
        }
      : {
          type: 'audio',
          codec: stream.codec_name || null,
          profile: stream.profile || null,
          sampleRate: Number(stream.sample_rate) || null,
          channels: Number(stream.channels) || null,
          layout: stream.channel_layout || null,
        })
}

export function concatCompatibilityIssue(metadataList) {
  const reference = JSON.stringify(streamCopySignature(metadataList[0]))
  if (reference === '[]') return '输入文件中没有可拼接的视频或音频流'
  for (let index = 1; index < metadataList.length; index += 1) {
    if (JSON.stringify(streamCopySignature(metadataList[index])) !== reference) {
      return `第 ${index + 1} 个片段的编码或流参数与第 1 个片段不一致`
    }
  }
  return null
}

export function validateTransformParameters(operation, args) {
  normalizeTimeout(args?.timeout_ms, DEFAULT_TRANSFORM_TIMEOUT_MS)
  if (operation === 'trim') {
    finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true, min: 0, minExclusive: true, max: 86_400,
    })
  } else if (operation === 'transcode') {
    codecArgs(args)
  } else if (operation === 'extract_frame') {
    finiteNumber(args.at_seconds, 'at_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    finiteNumber(args.width, 'width', { min: 1, max: 16_384 })
    finiteNumber(args.height, 'height', { min: 1, max: 16_384 })
  } else if (operation === 'extract_audio') {
    finiteInteger(args.audio_stream_index, 'audio_stream_index', { defaultValue: 0, min: 0, max: 63 })
    safeToken(args.audio_codec, 'audio_codec')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'change_speed') {
    finiteNumber(args.speed, 'speed', { required: true, min: MIN_PLAYBACK_SPEED, max: MAX_PLAYBACK_SPEED })
    requireReencodingCodec(args.video_codec, 'video_codec')
    requireReencodingCodec(args.audio_codec, 'audio_codec')
    safeToken(args.video_bitrate, 'video_bitrate')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'generate_gif') {
    finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true, min: 0, minExclusive: true, max: MAX_GIF_DURATION_SECONDS,
    })
    finiteNumber(args.fps, 'fps', { defaultValue: 12, min: 1, max: 60 })
    finiteInteger(args.width, 'width', { defaultValue: 480, min: 16, max: 4096 })
  } else if (operation === 'add_subtitles') {
    requireReencodingCodec(args.video_codec, 'video_codec')
    safeToken(args.audio_codec, 'audio_codec')
    safeToken(args.video_bitrate, 'video_bitrate')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'concat') {
    if (concatMode(args) === 'reencode') {
      requireReencodingCodec(args.video_codec, 'video_codec')
      requireReencodingCodec(args.audio_codec, 'audio_codec')
      safeToken(args.video_bitrate, 'video_bitrate')
      safeToken(args.audio_bitrate, 'audio_bitrate')
    }
  } else if (operation === 'adjust_audio') {
    finiteNumber(args.volume, 'volume', { required: true, min: 0, max: 10 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with adjust_audio')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'denoise_audio') {
    finiteNumber(args.noise_reduction_db, 'noise_reduction_db', { defaultValue: 12, min: 0.01, max: 40 })
    finiteNumber(args.noise_floor_db, 'noise_floor_db', { defaultValue: -50, min: -80, max: -20 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with denoise_audio')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  }
}

function concatTopology(metadataList) {
  const hasVideo = metadataList.map((metadata) => Boolean(firstStream(metadata, 'video')))
  const hasAudio = metadataList.map((metadata) => Boolean(firstStream(metadata, 'audio')))
  if (!hasVideo.some(Boolean) && !hasAudio.some(Boolean)) {
    throw toolError('输入文件中没有可拼接的视频或音频流', { code: 'MEDIA_CONCAT_NO_STREAMS' })
  }
  if (hasVideo.some((value) => value !== hasVideo[0]) || hasAudio.some((value) => value !== hasAudio[0])) {
    throw toolError('重新编码拼接要求所有片段具有一致的视频/音频流类型', {
      code: 'MEDIA_CONCAT_STREAM_MISMATCH',
      hint: '请先为缺少音轨或视频轨的片段补齐相同类型的流，再执行 concat_mode="reencode"。',
    })
  }
  return { hasVideo: hasVideo[0], hasAudio: hasAudio[0] }
}

function buildReencodeConcatArgs(command, args, inputs, metadataList) {
  const topology = concatTopology(metadataList)
  for (const input of inputs) command.push('-i', input.fullPath)

  const filters = []
  const orderedLabels = []
  let width = null
  let height = null
  if (topology.hasVideo) {
    const video = firstStream(metadataList[0], 'video')
    width = Math.floor(Number(video?.width) || 0)
    height = Math.floor(Number(video?.height) || 0)
    if (width < 2 || height < 2) throw toolError('无法读取首个片段的视频尺寸')
    width -= width % 2
    height -= height % 2
  }

  for (let index = 0; index < inputs.length; index += 1) {
    if (topology.hasVideo) {
      filters.push(
        `[${index}:v:0]settb=AVTB,setpts=PTS-STARTPTS,`
        + `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`,
      )
      orderedLabels.push(`[v${index}]`)
    }
    if (topology.hasAudio) {
      filters.push(
        `[${index}:a:0]aresample=48000,`
        + 'aformat=sample_rates=48000:channel_layouts=stereo,'
        + `asetpts=PTS-STARTPTS[a${index}]`,
      )
      orderedLabels.push(`[a${index}]`)
    }
  }

  const outputs = []
  if (topology.hasVideo) outputs.push('[vout]')
  if (topology.hasAudio) outputs.push('[aout]')
  filters.push(
    `${orderedLabels.join('')}concat=n=${inputs.length}:v=${topology.hasVideo ? 1 : 0}:a=${topology.hasAudio ? 1 : 0}`
    + outputs.join(''),
  )
  command.push('-filter_complex', filters.join(';'))
  if (topology.hasVideo) command.push('-map', '[vout]')
  if (topology.hasAudio) command.push('-map', '[aout]')

  const videoCodec = requireReencodingCodec(args.video_codec, 'video_codec')
  const audioCodec = requireReencodingCodec(args.audio_codec, 'audio_codec')
  const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
  const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
  if (topology.hasVideo && videoCodec) command.push('-c:v', videoCodec)
  if (topology.hasAudio && audioCodec) command.push('-c:a', audioCodec)
  if (topology.hasVideo && videoBitrate) command.push('-b:v', videoBitrate)
  if (topology.hasAudio && audioBitrate) command.push('-b:a', audioBitrate)
}

export function buildTransformArgs(operation, args, inputs, tempOutput, {
  concatListPath = null,
  concatMetadata = null,
  inputMetadata = null,
  outputMuxer,
  subtitleFilterName = null,
} = {}) {
  const command = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n']
  if (operation === 'trim') {
    const start = finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    const duration = finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true, min: 0, minExclusive: true, max: 86_400,
    })
    command.push('-ss', String(start), '-i', inputs[0].fullPath, '-t', String(duration), '-map', '0?', '-c', 'copy')
  } else if (operation === 'transcode') {
    command.push('-i', inputs[0].fullPath, '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', ...codecArgs(args))
  } else if (operation === 'extract_frame') {
    const at = finiteNumber(args.at_seconds, 'at_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    command.push('-ss', String(at), '-i', inputs[0].fullPath, '-frames:v', '1')
    const width = finiteNumber(args.width, 'width', { min: 1, max: 16_384 })
    const height = finiteNumber(args.height, 'height', { min: 1, max: 16_384 })
    if (width != null || height != null) {
      command.push('-vf', `scale=${width == null ? -1 : Math.floor(width)}:${height == null ? -1 : Math.floor(height)}`)
    }
  } else if (operation === 'extract_audio') {
    const streamIndex = finiteInteger(args.audio_stream_index, 'audio_stream_index', { defaultValue: 0, min: 0, max: 63 })
    command.push('-i', inputs[0].fullPath, '-map', `0:a:${streamIndex}`, '-vn', '-sn', '-dn')
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (audioCodec) command.push('-c:a', audioCodec)
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'change_speed') {
    const speed = finiteNumber(args.speed, 'speed', { required: true, min: MIN_PLAYBACK_SPEED, max: MAX_PLAYBACK_SPEED })
    const videoCodec = requireReencodingCodec(args.video_codec, 'video_codec')
    const audioCodec = requireReencodingCodec(args.audio_codec, 'audio_codec')
    const video = firstStream(inputMetadata, 'video')
    const audio = firstStream(inputMetadata, 'audio')
    if (!video && !audio) throw toolError('输入文件中没有可变速的视频或音频流')
    command.push('-i', inputs[0].fullPath)
    if (video) {
      command.push('-map', '0:v:0', '-vf', `setpts=(PTS-STARTPTS)/${speed}`)
      const sourceFrameRate = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate)
      if (sourceFrameRate) command.push('-r', String(Number((Math.min(sourceFrameRate * speed, 240)).toFixed(8))))
    }
    if (audio) command.push('-map', '0:a:0', '-af', `${buildAtempoChain(speed)},asetpts=PTS-STARTPTS`)
    if (videoCodec) command.push('-c:v', videoCodec)
    if (audioCodec) command.push('-c:a', audioCodec)
    const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (videoBitrate) command.push('-b:v', videoBitrate)
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'generate_gif') {
    const start = finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    const duration = finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true, min: 0, minExclusive: true, max: MAX_GIF_DURATION_SECONDS,
    })
    const fps = finiteNumber(args.fps, 'fps', { defaultValue: 12, min: 1, max: 60 })
    const width = finiteInteger(args.width, 'width', { defaultValue: 480, min: 16, max: 4096 })
    command.push(
      '-ss', String(start), '-i', inputs[0].fullPath, '-t', String(duration), '-an', '-filter_complex',
      `[0:v:0]fps=${fps},scale=${width}:-1:flags=lanczos,split[v0][v1];`
        + '[v0]palettegen=stats_mode=diff[p];[v1][p]paletteuse=dither=sierra2_4a',
      '-loop', '0',
    )
  } else if (operation === 'add_subtitles') {
    if (!subtitleFilterName) throw toolError('字幕临时文件未准备完成')
    const videoCodec = requireReencodingCodec(args.video_codec, 'video_codec')
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    command.push('-i', inputs[0].fullPath, '-map', '0:v:0', '-map', '0:a?', '-sn', '-vf', `subtitles=filename='${subtitleFilterName}'`)
    if (videoCodec) command.push('-c:v', videoCodec)
    if (audioCodec) command.push('-c:a', audioCodec)
    else command.push('-c:a', 'copy')
    if (videoBitrate) command.push('-b:v', videoBitrate)
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'concat') {
    if (concatMode(args) === 'copy') command.push('-f', 'concat', '-safe', '0', '-i', concatListPath, '-map', '0?', '-c', 'copy')
    else buildReencodeConcatArgs(command, args, inputs, concatMetadata)
  } else if (operation === 'adjust_audio') {
    const volume = finiteNumber(args.volume, 'volume', { required: true, min: 0, max: 10 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with adjust_audio')
    command.push('-i', inputs[0].fullPath, '-map', '0?', '-c:v', 'copy', '-filter:a', `volume=${volume}`)
    if (audioCodec) command.push('-c:a', audioCodec)
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'denoise_audio') {
    const reduction = finiteNumber(args.noise_reduction_db, 'noise_reduction_db', { defaultValue: 12, min: 0.01, max: 40 })
    const noiseFloor = finiteNumber(args.noise_floor_db, 'noise_floor_db', { defaultValue: -50, min: -80, max: -20 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with denoise_audio')
    command.push('-i', inputs[0].fullPath, '-map', '0?', '-c:v', 'copy', '-filter:a', `afftdn=nr=${reduction}:nf=${noiseFloor}`)
    if (audioCodec) command.push('-c:a', audioCodec)
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (audioBitrate) command.push('-b:a', audioBitrate)
  }
  if (!outputMuxer) throw toolError('未解析到安全的单文件输出格式')
  command.push('-f', outputMuxer, tempOutput)
  return command
}
