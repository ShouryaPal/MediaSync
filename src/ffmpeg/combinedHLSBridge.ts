import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import * as mediasoup from "mediasoup";
import { createSdpFile } from '../index';

// Helper: Wait for all SDP files to have a valid video size, with detailed logging
function waitForSdpReady(sdpPaths: string[], timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      let allReady = true;
      for (const sdpPath of sdpPaths) {
        if (!fs.existsSync(sdpPath)) {
          console.warn(`[SDP WAIT] Missing SDP: ${sdpPath}`);
          allReady = false;
          continue;
        }
        const content = fs.readFileSync(sdpPath, 'utf8');
        const sizeMatch = content.match(/a=framesize:(\d+)\s+(\d+)/) || content.match(/m=video \d+ [^ ]+ (\d+) (\d+)/);
        if (!sizeMatch) {
          console.warn(`[SDP WAIT] SDP missing video size: ${sdpPath}\n${content}`);
          allReady = false;
          continue;
        }
        const w = parseInt(sizeMatch[1], 10), h = parseInt(sizeMatch[2], 10);
        if (!w || !h) {
          console.warn(`[SDP WAIT] SDP has zero width/height: ${sdpPath}\n${content}`);
          allReady = false;
        }
      }
      if (allReady) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('SDP not ready'));
      setTimeout(check, 150);
    }
    check();
  });
}

// Helper function to build FFmpeg filter complex string for a grid layout with AV sync
function buildFilterComplex(
  inputCount: number, 
  audioInputCount: number,
  layout: { width: number; height: number },
  targetFps: number = 30
) {
  const filters: string[] = [];
  
  // Add FPS filter to all video inputs for consistent frame rate
  for (let i = 0; i < inputCount; i++) {
    filters.push(`[${i}:v]fps=${targetFps}[vfps${i}]`);
  }

  // 1 input: just scale and output as [v]
  if (inputCount === 1) {
    filters.push(`[vfps0]scale=${layout.width}:${layout.height}:force_original_aspect_ratio=decrease,pad=${layout.width}:${layout.height}:(ow-iw)/2:(oh-ih)/2:color=black[v]`);
    return filters.join(';');
  }

  // N > 1: arrange in grid
  const cols = Math.ceil(Math.sqrt(inputCount));
  const rows = Math.ceil(inputCount / cols);
  const cellWidth = Math.floor(layout.width / cols);
  const cellHeight = Math.floor(layout.height / rows);

  // Scale each input to cell size with consistent aspect ratio
  for (let i = 0; i < inputCount; i++) {
    filters.push(`[vfps${i}]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black[v${i}]`);
  }

  // Build grid layout
  let rowLabels: string[] = [];
  for (let row = 0; row < rows; row++) {
    let rowInputs: string[] = [];
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (idx >= inputCount) break;
      rowInputs.push(`[v${idx}]`);
    }
    if (rowInputs.length === 0) continue;
    if (rowInputs.length === 1) {
      rowLabels.push(rowInputs[0]);
    } else {
      filters.push(`${rowInputs.join('')}hstack=inputs=${rowInputs.length}[r${row}]`);
      rowLabels.push(`[r${row}]`);
    }
  }

  // Stack rows vertically
  if (rowLabels.length === 1) {
    filters.push(`${rowLabels[0]}copy[v]`);
  } else {
    filters.push(`${rowLabels.join('')}vstack=inputs=${rowLabels.length}[v]`);
  }

  return filters.join(';');
}

interface ProducerSession {
  videoProducer?: mediasoup.types.Producer;
  audioProducer?: mediasoup.types.Producer;
  clientId: string;
}

let combinedHlsFfmpegProcess: ReturnType<typeof spawn> | null = null;
let isUpdatingCombinedStream = false;

export async function setupCombinedHlsStream({
  sessions,
  getRouter,
  producerResources,
  config = {
    maxParticipants: 16,
    gridLayout: {
      single: { width: 1280, height: 720 },
      two: { width: 640, height: 720 },
      four: { width: 640, height: 360 },
      default: { width: 426, height: 240 },
    },
    output: {
      width: 1280,
      height: 720,
      bitrate: '3M', // Increased bitrate for higher FPS
      crf: '23',
      preset: 'medium',
      fps: 60, // Increased to 60 FPS
      gopSize: 120, // 2 seconds at 60fps
    },
    hls: {
      time: '2',
      listSize: '10',
      flags: 'delete_segments',
    },
    sync: {
      audioDelay: '0ms', // Adjust if needed based on your setup
      maxLatency: '500ms',
    }
  },
}: {
  sessions: Map<string, ProducerSession>;
  getRouter: () => mediasoup.types.Router;
  producerResources: Map<
    string,
    {
      ffmpeg: ReturnType<typeof spawn>;
      transports: mediasoup.types.PlainTransport[];
      consumers: mediasoup.types.Consumer[];
      updateLivePlaylist: NodeJS.Timeout;
    }
  >;
  config?: {
    maxParticipants: number;
    gridLayout: {
      single: { width: number; height: number };
      two: { width: number; height: number };
      four: { width: number; height: number };
      default: { width: number; height: number };
    };
    output: {
      width: number;
      height: number;
      bitrate: string;
      crf: string;
      preset: string;
      fps: number;
      gopSize: number;
    };
    hls: {
      time: string;
      listSize: string;
      flags: string;
    };
    sync: {
      audioDelay: string;
      maxLatency: string;
    };
  };
}) {
  if (isUpdatingCombinedStream) {
    console.log('[CombinedGrid] Update already in progress, skipping.');
    return;
  }
  isUpdatingCombinedStream = true;

  try {
    const combinedSessionId = "combined-stream";

    // Clean up existing combined stream process if it exists
    if (combinedHlsFfmpegProcess) {
      console.log('[CombinedGrid] Killing existing FFmpeg process for update.');
      combinedHlsFfmpegProcess.kill('SIGTERM');
      combinedHlsFfmpegProcess = null;
    }

    // Clean up associated resources
    if (producerResources.has(combinedSessionId)) {
      const resources = producerResources.get(combinedSessionId)!;
      resources.consumers.forEach((c) => c.close());
      resources.transports.forEach((t) => t.close());
      clearInterval(resources.updateLivePlaylist);
      producerResources.delete(combinedSessionId);
    }

    const hlsDir = path.join(process.cwd(), "hls", "combined");
    if (fs.existsSync(hlsDir)) {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(hlsDir, { recursive: true });

    if (sessions.size === 0) {
      console.log("No active sessions for combined stream. Cleanup complete.");
      return;
    }

    const numParticipants = Math.min(sessions.size, config.maxParticipants);
    const getLayoutConfig = (pCount: number) => {
      if (pCount === 1) return config.gridLayout.single;
      if (pCount <= 2) return config.gridLayout.two;
      if (pCount <= 4) return config.gridLayout.four;
      return config.gridLayout.default;
    };

    const inputs: string[] = [];
    const audioInputs: string[] = [];
    const transports: mediasoup.types.PlainTransport[] = [];
    const consumers: mediasoup.types.Consumer[] = [];
    let inputIndex = 0;

    // Synchronized keyframe interval - align with GOP structure
    const keyframeIntervals: NodeJS.Timeout[] = [];
    const keyframeIntervalMs = (config.output.gopSize / config.output.fps) * 1000;

    for (const [, session] of sessions) {
      if (!session.videoProducer) continue;
      if (inputIndex >= config.maxParticipants) break;

      // Use sequential ports to avoid conflicts
      const basePort = 20000 + (inputIndex * 4);
      const videoRtpPort = basePort;
      const videoRtcpPort = basePort + 1;
      const audioRtpPort = basePort + 2;
      const audioRtcpPort = basePort + 3;

      // VIDEO TRANSPORT
      const videoTransport = await getRouter().createPlainTransport({
        listenIp: { ip: '127.0.0.1' },
        rtcpMux: false,
        comedia: false,
      });
      await videoTransport.connect({
        ip: '127.0.0.1',
        port: videoRtpPort,
        rtcpPort: videoRtcpPort,
      });

      const videoProducer = session.videoProducer;
      let selectedCodec = videoProducer.rtpParameters.codecs.find(c => c.mimeType.toLowerCase().includes('h264'))
        || videoProducer.rtpParameters.codecs.find(c => c.mimeType.toLowerCase().includes('vp8'))
        || videoProducer.rtpParameters.codecs[0];

      const videoCodecCapability: mediasoup.types.RtpCodecCapability = {
        kind: 'video',
        mimeType: selectedCodec.mimeType,
        clockRate: selectedCodec.clockRate,
        channels: selectedCodec.channels,
        parameters: selectedCodec.parameters,
        rtcpFeedback: selectedCodec.rtcpFeedback,
      };

      const videoConsumer = await videoTransport.consume({
        producerId: videoProducer.id,
        rtpCapabilities: { codecs: [videoCodecCapability], headerExtensions: [] },
        paused: false,
      });

      // Synchronized keyframe requests aligned with GOP
      if (videoConsumer) {
        const interval = setInterval(() => {
          if (typeof videoConsumer.requestKeyFrame === 'function') {
            videoConsumer.requestKeyFrame().catch(() => {});
          }
        }, keyframeIntervalMs);
        keyframeIntervals.push(interval);
        
        try { await videoConsumer.resume(); } catch (e) { /* ignore */ }
        try { await videoConsumer.requestKeyFrame(); } catch (e) { /* ignore */ }
      }

      // Generate SDP for video
      const sdpPath = path.join(hlsDir, `input_${inputIndex}.sdp`);
      const consumerPayloadType = videoConsumer.rtpParameters.codecs[0]?.payloadType || selectedCodec.payloadType;
      
      const layout = getLayoutConfig(numParticipants);
      const cols = numParticipants > 1 ? Math.ceil(Math.sqrt(numParticipants)) : 1;
      const rows = numParticipants > 1 ? Math.ceil(numParticipants / cols) : 1;
      const cellWidth = Math.floor(layout.width / cols);
      const cellHeight = Math.floor(layout.height / rows);

      let sdpContent = createSdpFile(selectedCodec, consumerPayloadType, videoRtpPort, videoRtcpPort)
        + `a=framesize:${consumerPayloadType} ${cellWidth}-${cellHeight}\r\n`
        + `a=framerate:${config.output.fps}\r\n`;

      if (selectedCodec.mimeType.toLowerCase().includes('vp8')) {
        sdpContent += `a=fmtp:${consumerPayloadType} max-fr=${config.output.fps}; max-fs=3600\r\n`;
        if (videoConsumer.rtpParameters.encodings && videoConsumer.rtpParameters.encodings[0]?.ssrc) {
          sdpContent += `a=ssrc:${videoConsumer.rtpParameters.encodings[0].ssrc} cname:combinedgrid${inputIndex}\r\n`;
        }
      }

      fs.writeFileSync(sdpPath, sdpContent);
      inputs.push(sdpPath);
      transports.push(videoTransport);
      consumers.push(videoConsumer);

      // AUDIO TRANSPORT (reuse same session)
      if (session.audioProducer) {
        const audioTransport = await getRouter().createPlainTransport({
          listenIp: { ip: '127.0.0.1' },
          rtcpMux: false,
          comedia: false,
        });
        await audioTransport.connect({
          ip: '127.0.0.1',
          port: audioRtpPort,
          rtcpPort: audioRtcpPort,
        });

        const audioProducer = session.audioProducer;
        let selectedAudioCodec = audioProducer.rtpParameters.codecs.find(c => c.mimeType.toLowerCase().includes('opus'))
          || audioProducer.rtpParameters.codecs[0];

        const audioCodecCapability: mediasoup.types.RtpCodecCapability = {
          kind: 'audio',
          mimeType: selectedAudioCodec.mimeType,
          clockRate: selectedAudioCodec.clockRate,
          channels: selectedAudioCodec.channels,
          parameters: selectedAudioCodec.parameters,
          rtcpFeedback: selectedAudioCodec.rtcpFeedback,
        };

        const audioConsumer = await audioTransport.consume({
          producerId: audioProducer.id,
          rtpCapabilities: { codecs: [audioCodecCapability], headerExtensions: [] },
          paused: false,
        });

        try { await audioConsumer.resume(); } catch (e) { /* ignore */ }

        // Generate SDP for audio
        const audioSdpPath = path.join(hlsDir, `audio_${inputIndex}.sdp`);
        const audioPayloadType = audioConsumer.rtpParameters.codecs[0]?.payloadType || selectedAudioCodec.payloadType;
        let audioSdpContent = createSdpFile(selectedAudioCodec, audioPayloadType, audioRtpPort, audioRtcpPort);

        if (audioConsumer.rtpParameters.encodings && audioConsumer.rtpParameters.encodings[0]?.ssrc) {
          audioSdpContent += `a=ssrc:${audioConsumer.rtpParameters.encodings[0].ssrc} cname:combinedgridaudio${inputIndex}\r\n`;
        }

        fs.writeFileSync(audioSdpPath, audioSdpContent);
        audioInputs.push(audioSdpPath);
        transports.push(audioTransport);
        consumers.push(audioConsumer);
      }

      inputIndex++;
    }

    if (inputs.length === 0) {
      console.warn('[CombinedGrid] No valid video inputs found, aborting.');
      return;
    }

    try {
      // Only wait for video SDPs since audio SDPs don't have framesize info
      await waitForSdpReady(inputs, 10000);
    } catch (err) {
      console.warn('[CombinedGrid] Video SDPs not ready, will retry update.', err);
      setTimeout(() => setupCombinedHlsStream({ sessions, getRouter, producerResources, config }), 2000);
      return;
    }

    const layout = getLayoutConfig(numParticipants);
    let filterComplex = buildFilterComplex(inputs.length, audioInputs.length, layout, config.output.fps);

    // Build FFmpeg input args with optimized settings
    const ffmpegInputArgs = [
      ...inputs.flatMap(i => [
        '-protocol_whitelist', 'file,udp,rtp',
        '-fflags', '+genpts+igndts',
        '-avoid_negative_ts', 'make_zero',
        '-i', i
      ]),
      ...audioInputs.flatMap(i => [
        '-protocol_whitelist', 'file,udp,rtp',
        '-fflags', '+genpts+igndts', 
        '-avoid_negative_ts', 'make_zero',
        '-i', i
      ])
    ];

    // Build audio mixing filter with sync
    let mapArgs = ['-map', '[v]'];
    if (audioInputs.length > 0) {
      const audioInputLabels = audioInputs.map((_, idx) => `[${inputs.length + idx}:a]`).join('');
      // Include audio delay in the complex filter instead of using -af
      filterComplex += `;${audioInputLabels}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=2,adelay=${config.sync.audioDelay}:all=true[a]`;
      mapArgs.push('-map', '[a]');
    }

    const ffmpegArgs = [
      // Reduced buffer sizes for lower latency
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      '-max_delay', '500000',
      ...ffmpegInputArgs,
      '-filter_complex', filterComplex,
      ...mapArgs,
      // Video encoding with optimized settings
      '-c:v', 'libx264',
      '-preset', config.output.preset,
      '-crf', config.output.crf,
      '-b:v', config.output.bitrate,
      '-maxrate', config.output.bitrate,
      '-bufsize', '4M',
      '-r', config.output.fps.toString(),
      '-g', config.output.gopSize.toString(),
      '-keyint_min', config.output.gopSize.toString(),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${config.output.gopSize / config.output.fps})`,
      // Audio encoding with sync
      ...(audioInputs.length > 0 ? [
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-async', '1'
      ] : []),
      // AV sync settings
      '-vsync', 'cfr',
      '-copytb', '1',
      '-avoid_negative_ts', 'make_zero',
      // HLS settings optimized for sync
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '2',
      '-hls_flags', 'delete_segments+omit_endlist+program_date_time+independent_segments',
      '-hls_segment_type', 'fmp4',
      '-hls_playlist_type', 'event',
      '-start_number', '0',
      path.join(hlsDir, 'playlist.m3u8')
    ];

    console.log(`[CombinedGrid] Starting FFmpeg with ${inputs.length} video + ${audioInputs.length} audio inputs. Layout: ${Math.ceil(numParticipants/Math.ceil(Math.sqrt(numParticipants)))}x${Math.ceil(Math.sqrt(numParticipants))}.`);
    console.log(`[CombinedGrid] FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    combinedHlsFfmpegProcess = ffmpegProc;

    let ffmpegStarted = false;
    const cleanupKeyframeIntervals = () => {
      keyframeIntervals.forEach(interval => clearInterval(interval));
    };

    ffmpegProc.stdout.on('data', (data: Buffer) => {
      if (!ffmpegStarted) {
        console.log('[CombinedGrid] FFmpeg output started');
        ffmpegStarted = true;
      }
    });

    ffmpegProc.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      // Log important messages, filter out noise
      if (output.includes('frame=') || output.includes('time=') || output.includes('bitrate=')) {
        // Only log every 10th progress message to reduce spam
        if (Math.random() < 0.1) {
          console.log(`[Combined FFmpeg]: ${output.trim()}`);
        }
      } else if (output.includes('error') || output.includes('Error') || output.includes('warning')) {
        console.error(`[Combined FFmpeg ERROR]: ${output}`);
      }
    });

    ffmpegProc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.log(`[Combined FFmpeg] exited with code ${code}, signal ${signal}`);
      combinedHlsFfmpegProcess = null;
      cleanupKeyframeIntervals();
    });

    ffmpegProc.on('error', (error) => {
      console.error('[Combined FFmpeg] Process error:', error);
      combinedHlsFfmpegProcess = null;
      cleanupKeyframeIntervals();
    });

    const updateLivePlaylist = setInterval(() => {
      const playlistPath = path.join(hlsDir, 'playlist.m3u8');
      if (fs.existsSync(playlistPath)) {
        fs.utimesSync(playlistPath, new Date(), new Date());
      }
    }, 1000);

    producerResources.set(combinedSessionId, { 
      ffmpeg: ffmpegProc, 
      transports, 
      consumers, 
      updateLivePlaylist 
    });

  } catch (error) {
    console.error('[CombinedGrid] Error in setupCombinedHlsStream:', error);
  } finally {
    isUpdatingCombinedStream = false;
  }
}