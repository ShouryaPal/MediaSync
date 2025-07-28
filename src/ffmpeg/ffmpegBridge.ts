import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import * as mediasoup from "mediasoup";

export async function setupHlsFfmpegBridge({
  videoProducer,
  audioProducer,
  getRouter,
  producerResources,
  createSdpFile
}: {
  videoProducer: mediasoup.types.Producer | null,
  audioProducer: mediasoup.types.Producer | null,
  getRouter: () => mediasoup.types.Router,
  producerResources: Map<string, { ffmpeg: ReturnType<typeof spawn>, transports: mediasoup.types.PlainTransport[], consumers: mediasoup.types.Consumer[], updateLivePlaylist: NodeJS.Timeout }>;
  createSdpFile: Function;
}) {
  // Clean up any previous ffmpeg/transport for this session (use videoProducer.id as session id)
  const sessionId = videoProducer?.id || audioProducer?.id;
  if (!sessionId) return;
  if (producerResources.has(sessionId)) {
    const { ffmpeg, transports, consumers, updateLivePlaylist } = producerResources.get(sessionId)!;
    ffmpeg.kill("SIGTERM");
    clearInterval(updateLivePlaylist);
    consumers.forEach(c => c.close());
    transports.forEach(t => t.close());
    producerResources.delete(sessionId);
  }

  try {
    const hlsDir = path.join(process.cwd(), "hls", sessionId);
    fs.mkdirSync(hlsDir, { recursive: true });

    // Setup video transport/consumer
    let videoTransport, videoConsumer, videoCodec, videoRtpPort, videoRtcpPort;
    if (videoProducer) {
      videoTransport = await getRouter().createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        rtcpMux: false,
        comedia: false,
      });
      videoRtpPort = Math.floor(Math.random() * (65535 - 10000)) + 10000;
      videoRtcpPort = videoRtpPort + 1;
      await videoTransport.connect({
        ip: "127.0.0.1",
        port: videoRtpPort,
        rtcpPort: videoRtcpPort,
      });
      const prodCodec = videoProducer.rtpParameters.codecs[0];
      videoCodec = {
        kind: 'video' as mediasoup.types.MediaKind,
        mimeType: prodCodec.mimeType,
        clockRate: prodCodec.clockRate,
        preferredPayloadType: prodCodec.payloadType,
        channels: prodCodec.channels,
        parameters: prodCodec.parameters,
        rtcpFeedback: prodCodec.rtcpFeedback,
      };
      videoConsumer = await videoTransport.consume({
        producerId: videoProducer.id,
        rtpCapabilities: {
          codecs: [videoCodec],
          headerExtensions: [],
        },
        paused: false,
      });
    }

    // Setup audio transport/consumer
    let audioTransport, audioConsumer, audioCodec, audioRtpPort, audioRtcpPort;
    if (audioProducer) {
      audioTransport = await getRouter().createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        rtcpMux: false,
        comedia: false,
      });
      audioRtpPort = Math.floor(Math.random() * (65535 - 10000)) + 10000;
      audioRtcpPort = audioRtpPort + 1;
      await audioTransport.connect({
        ip: "127.0.0.1",
        port: audioRtpPort,
        rtcpPort: audioRtcpPort,
      });
      const prodCodec = audioProducer.rtpParameters.codecs[0];
      audioCodec = {
        kind: 'audio' as mediasoup.types.MediaKind,
        mimeType: prodCodec.mimeType,
        clockRate: prodCodec.clockRate,
        preferredPayloadType: prodCodec.payloadType,
        channels: prodCodec.channels,
        parameters: prodCodec.parameters,
        rtcpFeedback: prodCodec.rtcpFeedback,
      };
      audioConsumer = await audioTransport.consume({
        producerId: audioProducer.id,
        rtpCapabilities: {
          codecs: [audioCodec],
          headerExtensions: [],
        },
        paused: false,
      });
    }

    // Generate SDP with both audio and video if present
    let sdpContent = '';
    if (videoConsumer) {
      sdpContent += createSdpFile(
        videoConsumer.rtpParameters.codecs[0],
        videoConsumer.rtpParameters.codecs[0].payloadType,
        videoRtpPort,
        videoRtcpPort
      );
    }
    if (audioConsumer) {
      sdpContent += createSdpFile(
        audioConsumer.rtpParameters.codecs[0],
        audioConsumer.rtpParameters.codecs[0].payloadType,
        audioRtpPort,
        audioRtcpPort
      );
    }
    const sdpPath = path.join(hlsDir, "stream.sdp");
    fs.writeFileSync(sdpPath, sdpContent);

    // FFmpeg args for both audio and video
    const ffmpegArgs = [
      "-protocol_whitelist", "file,udp,rtp",
      "-f", "sdp",
      "-i", sdpPath,
    ];
    if (videoConsumer) {
      ffmpegArgs.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-pix_fmt", "yuv420p",
        "-g", "30",
        "-keyint_min", "30",
        "-sc_threshold", "0",
        "-b:v", "500k",
        "-maxrate", "500k",
        "-bufsize", "1000k"
      );
    }
    if (audioConsumer) {
      ffmpegArgs.push(
        "-c:a", "aac",
        "-b:a", "128k"
      );
    }
    ffmpegArgs.push(
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "5",
      "-hls_flags", "delete_segments+append_list",
      "-hls_segment_filename", path.join(hlsDir, "segment_%03d.ts"),
      path.join(hlsDir, "playlist.m3u8")
    );

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { 
      stdio: ["ignore", "pipe", "pipe"]
    });

    ffmpeg.stdout?.on('data', (data) => {});
    ffmpeg.stderr?.on('data', (data) => {});

    const liveDir = path.join(process.cwd(), "hls", "live");
    fs.mkdirSync(liveDir, { recursive: true });
    const srcPlaylist = path.join(hlsDir, "playlist.m3u8");
    const destPlaylist = path.join(liveDir, "playlist.m3u8");
    const updateLivePlaylist = setInterval(() => {
      try {
        if (fs.existsSync(srcPlaylist)) {
          fs.copyFileSync(srcPlaylist, destPlaylist);
          const files = fs.readdirSync(hlsDir);
          const segments = files.filter(file => file.endsWith('.ts'));
          segments.forEach(file => {
            const srcSegment = path.join(hlsDir, file);
            const destSegment = path.join(liveDir, file);
            if (fs.existsSync(srcSegment)) {
              fs.copyFileSync(srcSegment, destSegment);
            }
          });
        }
      } catch (error) {}
    }, 2000);

    producerResources.set(sessionId, {
      ffmpeg,
      transports: [videoTransport, audioTransport].filter((t): t is mediasoup.types.PlainTransport => !!t),
      consumers: [videoConsumer, audioConsumer].filter((c): c is mediasoup.types.Consumer => !!c),
      updateLivePlaylist
    });

    // Cleanup on transportclose
    [videoProducer, audioProducer].forEach((producer) => {
      if (!producer) return;
      producer.on("transportclose", () => {
        if (producerResources.has(sessionId)) {
          const { ffmpeg, transports, consumers, updateLivePlaylist } = producerResources.get(sessionId)!;
          ffmpeg.kill("SIGTERM");
          clearInterval(updateLivePlaylist);
          consumers.forEach(c => c.close());
          transports.forEach(t => t.close());
          producerResources.delete(sessionId);
          try {
            if (fs.existsSync(hlsDir)) {
              fs.rmSync(hlsDir, { recursive: true, force: true });
            }
          } catch (error) {}
        }
      });
    });
  } catch (error) {}
} 