import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import * as mediasoup from "mediasoup";

export async function setupHlsFfmpegBridge({
  videoProducer,
  audioProducer,
  getRouter,
  producerResources,
  createSdpFile,
}: {
  videoProducer: mediasoup.types.Producer | null;
  audioProducer: mediasoup.types.Producer | null;
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
  createSdpFile: Function;
}) {
  const sessionId = videoProducer?.id || audioProducer?.id;
  if (!sessionId) return;
  if (producerResources.has(sessionId)) {
    const { ffmpeg, transports, consumers, updateLivePlaylist } =
      producerResources.get(sessionId)!;
    ffmpeg.kill("SIGTERM");
    clearInterval(updateLivePlaylist);
    consumers.forEach((c) => c.close());
    transports.forEach((t) => t.close());
    producerResources.delete(sessionId);
  }

  try {
    const hlsDir = path.join(process.cwd(), "hls", sessionId);
    fs.mkdirSync(hlsDir, { recursive: true });

    let videoTransport,
      videoConsumer,
      videoCodec,
      videoRtpPort,
      videoRtcpPort,
      videoPayloadType;
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
        kind: "video" as mediasoup.types.MediaKind,
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

    let audioTransport,
      audioConsumer,
      audioCodec,
      audioRtpPort,
      audioRtcpPort,
      audioPayloadType;
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
        kind: "audio" as mediasoup.types.MediaKind,
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

    let sdpContent =
      "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mediasoup\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n";

    if (videoConsumer) {
      videoPayloadType = videoConsumer.rtpParameters.codecs[0].payloadType;
      const mime = videoConsumer.rtpParameters.codecs[0].mimeType.toLowerCase();
      let codecName = "";

      if (mime.includes("vp8")) {
        codecName = "VP8";
      } else if (mime.includes("vp9")) {
        codecName = "VP9";
      } else if (mime.includes("h264")) {
        codecName = "H264";
      } else {
        codecName = videoConsumer.rtpParameters.codecs[0].mimeType
          .split("/")[1]
          .toUpperCase();
      }

      sdpContent += `m=video ${videoRtpPort} RTP/AVP ${videoPayloadType}\r\n`;
      sdpContent += `a=rtpmap:${videoPayloadType} ${codecName}/${videoConsumer.rtpParameters.codecs[0].clockRate}\r\n`;

      if (
        mime.includes("h264") &&
        videoConsumer.rtpParameters.codecs[0].parameters
      ) {
        const params: string[] = [];
        if (
          videoConsumer.rtpParameters.codecs[0].parameters["packetization-mode"]
        ) {
          params.push(
            `packetization-mode=${videoConsumer.rtpParameters.codecs[0].parameters["packetization-mode"]}`,
          );
        }
        if (
          videoConsumer.rtpParameters.codecs[0].parameters["profile-level-id"]
        ) {
          params.push(
            `profile-level-id=${videoConsumer.rtpParameters.codecs[0].parameters["profile-level-id"]}`,
          );
        }
        if (params.length > 0) {
          sdpContent += `a=fmtp:${videoPayloadType} ${params.join(";")}\r\n`;
        }
      }

      sdpContent += `a=sendonly\r\na=rtcp:${videoRtcpPort}\r\n`;
    }

    if (audioConsumer) {
      audioPayloadType = audioConsumer.rtpParameters.codecs[0].payloadType;
      const mime = audioConsumer.rtpParameters.codecs[0].mimeType.toLowerCase();
      let codecName = "";
      const channels = audioConsumer.rtpParameters.codecs[0].channels || 2;

      if (mime.includes("opus")) {
        codecName = "OPUS";
      } else if (mime.includes("aac")) {
        codecName = "MPEG4-GENERIC";
      } else {
        codecName = audioConsumer.rtpParameters.codecs[0].mimeType
          .split("/")[1]
          .toUpperCase();
      }

      sdpContent += `m=audio ${audioRtpPort} RTP/AVP ${audioPayloadType}\r\n`;
      sdpContent += `a=rtpmap:${audioPayloadType} ${codecName}/${audioConsumer.rtpParameters.codecs[0].clockRate}/${channels}\r\n`;

      if (audioConsumer.rtpParameters.codecs[0].parameters) {
        const params: string[] = [];
        Object.entries(
          audioConsumer.rtpParameters.codecs[0].parameters,
        ).forEach(([key, value]) => {
          params.push(`${key}=${value}`);
        });
        if (params.length > 0) {
          sdpContent += `a=fmtp:${audioPayloadType} ${params.join(";")}\r\n`;
        }
      }

      sdpContent += `a=sendonly\r\na=rtcp:${audioRtcpPort}\r\n`;
    }
    const sdpPath = path.join(hlsDir, "stream.sdp");
    fs.writeFileSync(sdpPath, sdpContent);

    const ffmpegArgs = [
      "-protocol_whitelist",
      "file,udp,rtp",
      "-f",
      "sdp",
      "-i",
      sdpPath,
    ];
    if (videoConsumer) {
      ffmpegArgs.push(
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "25",
        "-keyint_min",
        "25",
        "-sc_threshold",
        "40",
        "-b:v",
        "1000k",
        "-maxrate",
        "1500k",
        "-bufsize",
        "2000k",
        "-force_key_frames",
        "expr:gte(t,n_forced*1)",
        "-vsync",
        "1",
      );
    }
    if (audioConsumer) {
      ffmpegArgs.push("-c:a", "aac", "-b:a", "128k");
    }
    ffmpegArgs.push(
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_list_size",
      "5",
      "-hls_flags",
      "delete_segments+append_list+program_date_time+split_by_time+independent_segments",
      "-hls_segment_type",
      "mpegts",
      "-hls_segment_filename",
      path.join(hlsDir, "segment_%03d.ts"),
      path.join(hlsDir, "playlist.m3u8"),
    );

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    ffmpeg.stdout?.on("data", (data) => {
      console.log(`[FFmpeg stdout] ${data.toString()}`);
    });

    ffmpeg.stderr?.on("data", (data) => {
      console.log(`[FFmpeg stderr] ${data.toString()}`);
    });

    ffmpeg.on("error", (err) => {
      console.error(`[FFmpeg] Error: ${err.message}`);
    });

    ffmpeg.on("exit", (code) => {
      console.log(`[FFmpeg] process exited with code ${code}`);
    });

    const liveDir = path.join(process.cwd(), "hls", "live");
    fs.mkdirSync(liveDir, { recursive: true });
    const srcPlaylist = path.join(hlsDir, "playlist.m3u8");
    const destPlaylist = path.join(liveDir, "playlist.m3u8");
    const updateLivePlaylist = setInterval(() => {
      try {
        if (fs.existsSync(srcPlaylist)) {
          fs.copyFileSync(srcPlaylist, destPlaylist);
          const files = fs.readdirSync(hlsDir);
          const segments = files.filter((file) => file.endsWith(".ts"));
          segments.forEach((file) => {
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
      transports: [videoTransport, audioTransport].filter(
        (t): t is mediasoup.types.PlainTransport => !!t,
      ),
      consumers: [videoConsumer, audioConsumer].filter(
        (c): c is mediasoup.types.Consumer => !!c,
      ),
      updateLivePlaylist,
    });

    [videoProducer, audioProducer].forEach((producer) => {
      if (!producer) return;
      producer.on("transportclose", () => {
        if (producerResources.has(sessionId)) {
          const { ffmpeg, transports, consumers, updateLivePlaylist } =
            producerResources.get(sessionId)!;
          ffmpeg.kill("SIGTERM");
          clearInterval(updateLivePlaylist);
          consumers.forEach((c) => c.close());
          transports.forEach((t) => t.close());
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
