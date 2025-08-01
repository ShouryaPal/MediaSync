import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import * as mediasoup from "mediasoup";

interface ProducerInfo {
  producer: mediasoup.types.Producer;
  transport: mediasoup.types.PlainTransport;
  consumer: mediasoup.types.Consumer;
  rtpPort: number;
  rtcpPort: number;
  clientId: string;
}

interface CompositeSession {
  sessionId: string;
  ffmpeg: ReturnType<typeof spawn>;
  videoProducers: Map<string, ProducerInfo>;
  audioProducers: Map<string, ProducerInfo>;
  updateLivePlaylist: NodeJS.Timeout;
  isActive: boolean;
}

// Global composite session - only one active at a time
let compositeSession: CompositeSession | null = null;

export async function setupCompositeHlsFfmpegBridge({
  getRouter,
  producerResources,
  createSdpFile,
}: {
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
  const sessionId = "composite-stream";
  
  // Clean up existing composite session
  if (compositeSession) {
    await cleanupCompositeSession();
  }

  try {
    const hlsDir = path.join(process.cwd(), "hls", sessionId);
    fs.mkdirSync(hlsDir, { recursive: true });

    compositeSession = {
      sessionId,
      ffmpeg: null as any,
      videoProducers: new Map(),
      audioProducers: new Map(),
      updateLivePlaylist: null as any,
      isActive: true,
    };

    // Start with a placeholder FFmpeg process that we'll restart when needed
    await restartCompositeFFmpeg();

    const liveDir = path.join(process.cwd(), "hls", "live");
    fs.mkdirSync(liveDir, { recursive: true });
    
    const updateLivePlaylist = setInterval(() => {
      try {
        const srcPlaylist = path.join(hlsDir, "playlist.m3u8");
        const destPlaylist = path.join(liveDir, "playlist.m3u8");
        
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
      } catch (error) {
        console.error("Error updating live playlist:", error);
      }
    }, 1000);

    compositeSession.updateLivePlaylist = updateLivePlaylist;

    // Store in producerResources for cleanup
    producerResources.set(sessionId, {
      ffmpeg: compositeSession.ffmpeg,
      transports: [],
      consumers: [],
      updateLivePlaylist,
    });

  } catch (error) {
    console.error("Error setting up composite HLS bridge:", error);
  }
}

export async function addProducerToComposite({
  producer,
  clientId,
  getRouter,
}: {
  producer: mediasoup.types.Producer;
  clientId: string;
  getRouter: () => mediasoup.types.Router;
}) {
  if (!compositeSession || !compositeSession.isActive) {
    console.log("No active composite session, creating one...");
    return;
  }

  try {
    // Create plain transport for this producer
    const transport = await getRouter().createPlainTransport({
      listenIp: { ip: "127.0.0.1" },
      rtcpMux: false,
      comedia: false,
    });

    const rtpPort = Math.floor(Math.random() * (65535 - 10000)) + 10000;
    const rtcpPort = rtpPort + 1;

    await transport.connect({
      ip: "127.0.0.1",
      port: rtpPort,
      rtcpPort: rtcpPort,
    });

    // Create codec for consumer
    const prodCodec = producer.rtpParameters.codecs[0];
    const codec = {
      kind: producer.kind,
      mimeType: prodCodec.mimeType,
      clockRate: prodCodec.clockRate,
      preferredPayloadType: prodCodec.payloadType,
      channels: prodCodec.channels,
      parameters: prodCodec.parameters,
      rtcpFeedback: prodCodec.rtcpFeedback,
    };

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: {
        codecs: [codec],
        headerExtensions: [],
      },
      paused: false,
    });

    const producerInfo: ProducerInfo = {
      producer,
      transport,
      consumer,
      rtpPort,
      rtcpPort,
      clientId,
    };

    // Add to appropriate map
    if (producer.kind === "video") {
      compositeSession.videoProducers.set(producer.id, producerInfo);
    } else {
      compositeSession.audioProducers.set(producer.id, producerInfo);
    }

    // Handle producer close
    producer.on("transportclose", () => {
      removeProducerFromComposite(producer.id);
    });

    // Restart FFmpeg with new layout
    await restartCompositeFFmpeg();

    console.log(`Added ${producer.kind} producer ${producer.id} to composite stream`);

  } catch (error) {
    console.error("Error adding producer to composite:", error);
  }
}

export async function removeProducerFromComposite(producerId: string) {
  if (!compositeSession) return;

  const videoProducer = compositeSession.videoProducers.get(producerId);
  const audioProducer = compositeSession.audioProducers.get(producerId);

  if (videoProducer) {
    videoProducer.consumer.close();
    videoProducer.transport.close();
    compositeSession.videoProducers.delete(producerId);
  }

  if (audioProducer) {
    audioProducer.consumer.close();
    audioProducer.transport.close();
    compositeSession.audioProducers.delete(producerId);
  }

  // Restart FFmpeg with updated layout
  await restartCompositeFFmpeg();

  console.log(`Removed producer ${producerId} from composite stream`);
}

async function restartCompositeFFmpeg() {
  if (!compositeSession) return;

  // Kill existing FFmpeg process
  if (compositeSession.ffmpeg) {
    compositeSession.ffmpeg.kill("SIGTERM");
  }

  const hlsDir = path.join(process.cwd(), "hls", compositeSession.sessionId);
  
  // Create SDP content for all active producers
  let sdpContent = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mediasoup\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n";
  
  const videoProducers = Array.from(compositeSession.videoProducers.values());
  const audioProducers = Array.from(compositeSession.audioProducers.values());

  // Add video streams to SDP
  videoProducers.forEach((producerInfo, index) => {
    const consumer = producerInfo.consumer;
    const payloadType = consumer.rtpParameters.codecs[0].payloadType;
    const mime = consumer.rtpParameters.codecs[0].mimeType.toLowerCase();
    
    let codecName = "";
    if (mime.includes("vp8")) codecName = "VP8";
    else if (mime.includes("vp9")) codecName = "VP9";
    else if (mime.includes("h264")) codecName = "H264";
    else codecName = consumer.rtpParameters.codecs[0].mimeType.split("/")[1].toUpperCase();

    sdpContent += `m=video ${producerInfo.rtpPort} RTP/AVP ${payloadType}\r\n`;
    sdpContent += `a=rtpmap:${payloadType} ${codecName}/${consumer.rtpParameters.codecs[0].clockRate}\r\n`;
    
    if (mime.includes("h264") && consumer.rtpParameters.codecs[0].parameters) {
      const params: string[] = [];
      if (consumer.rtpParameters.codecs[0].parameters["packetization-mode"]) {
        params.push(`packetization-mode=${consumer.rtpParameters.codecs[0].parameters["packetization-mode"]}`);
      }
      if (consumer.rtpParameters.codecs[0].parameters["profile-level-id"]) {
        params.push(`profile-level-id=${consumer.rtpParameters.codecs[0].parameters["profile-level-id"]}`);
      }
      if (params.length > 0) {
        sdpContent += `a=fmtp:${payloadType} ${params.join(";")}\r\n`;
      }
    }
    
    sdpContent += `a=sendonly\r\na=rtcp:${producerInfo.rtcpPort}\r\n`;
  });

  // Add audio streams to SDP (we'll mix the first available audio)
  if (audioProducers.length > 0) {
    const audioProducer = audioProducers[0]; // Use first audio stream for now
    const consumer = audioProducer.consumer;
    const payloadType = consumer.rtpParameters.codecs[0].payloadType;
    const mime = consumer.rtpParameters.codecs[0].mimeType.toLowerCase();
    const channels = consumer.rtpParameters.codecs[0].channels || 2;
    
    let codecName = "";
    if (mime.includes("opus")) codecName = "OPUS";
    else if (mime.includes("aac")) codecName = "MPEG4-GENERIC";
    else codecName = consumer.rtpParameters.codecs[0].mimeType.split("/")[1].toUpperCase();

    sdpContent += `m=audio ${audioProducer.rtpPort} RTP/AVP ${payloadType}\r\n`;
    sdpContent += `a=rtpmap:${payloadType} ${codecName}/${consumer.rtpParameters.codecs[0].clockRate}/${channels}\r\n`;
    
    if (consumer.rtpParameters.codecs[0].parameters) {
      const params: string[] = [];
      Object.entries(consumer.rtpParameters.codecs[0].parameters).forEach(([key, value]) => {
        params.push(`${key}=${value}`);
      });
      if (params.length > 0) {
        sdpContent += `a=fmtp:${payloadType} ${params.join(";")}\r\n`;
      }
    }
    
    sdpContent += `a=sendonly\r\na=rtcp:${audioProducer.rtcpPort}\r\n`;
  }

  const sdpPath = path.join(hlsDir, "composite.sdp");
  fs.writeFileSync(sdpPath, sdpContent);

  // Build FFmpeg arguments for composite stream
  const ffmpegArgs = [
    "-protocol_whitelist", "file,udp,rtp",
    "-f", "sdp",
    "-i", sdpPath,
  ];

  // Video processing - create composite layout
  if (videoProducers.length > 0) {
    if (videoProducers.length === 1) {
      // Single video - just encode
      ffmpegArgs.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-pix_fmt", "yuv420p",
        "-s", "1280x720",
        "-g", "25",
        "-keyint_min", "25",
        "-sc_threshold", "40",
        "-b:v", "2000k",
        "-maxrate", "3000k",
        "-bufsize", "4000k",
        "-force_key_frames", "expr:gte(t,n_forced*1)"
      );
    } else if (videoProducers.length === 2) {
      // Two videos side by side
      ffmpegArgs.push(
        "-filter_complex", "[0:v]scale=640:720[left];[1:v]scale=640:720[right];[left][right]hstack=inputs=2:shortest=1[v]",
        "-map", "[v]",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-pix_fmt", "yuv420p",
        "-s", "1280x720",
        "-g", "25",
        "-keyint_min", "25",
        "-sc_threshold", "40",
        "-b:v", "2000k",
        "-maxrate", "3000k",
        "-bufsize", "4000k",
        "-force_key_frames", "expr:gte(t,n_forced*1)"
      );
    } else if (videoProducers.length <= 4) {
      // 2x2 grid layout
      ffmpegArgs.push(
        "-filter_complex", 
        `[0:v]scale=640:360[v0];[1:v]scale=640:360[v1];${videoProducers.length > 2 ? '[2:v]scale=640:360[v2];' : ''}${videoProducers.length > 3 ? '[3:v]scale=640:360[v3];' : ''}[v0][v1]hstack=inputs=2[top];${videoProducers.length > 2 ? (videoProducers.length > 3 ? '[v2][v3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[v]' : '[v2]pad=1280:360:640:0[bottom];[top][bottom]vstack=inputs=2[v]') : '[top]pad=1280:720:0:360[v]'}`,
        "-map", "[v]",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-pix_fmt", "yuv420p",
        "-s", "1280x720",
        "-g", "25",
        "-keyint_min", "25",
        "-sc_threshold", "40",
        "-b:v", "2000k",
        "-maxrate", "3000k",
        "-bufsize", "4000k",
        "-force_key_frames", "expr:gte(t,n_forced*1)"
      );
    } else {
      // More than 4 - use a grid layout (this is simplified, you can make it more sophisticated)
      ffmpegArgs.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-pix_fmt", "yuv420p",
        "-s", "1280x720",
        "-g", "25",
        "-keyint_min", "25",
        "-sc_threshold", "40",
        "-b:v", "2000k",
        "-maxrate", "3000k",
        "-bufsize", "4000k",
        "-force_key_frames", "expr:gte(t,n_forced*1)"
      );
    }
  }

  // Audio processing
  if (audioProducers.length > 0) {
    ffmpegArgs.push("-c:a", "aac", "-b:a", "128k");
  }

  // HLS output
  ffmpegArgs.push(
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "5",
    "-hls_flags", "delete_segments+append_list+program_date_time+split_by_time+independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", path.join(hlsDir, "segment_%03d.ts"),
    path.join(hlsDir, "playlist.m3u8")
  );

  // Start FFmpeg process
  compositeSession.ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  compositeSession.ffmpeg.stdout?.on("data", (data) => {
    console.log(`[Composite FFmpeg stdout] ${data.toString()}`);
  });

  compositeSession.ffmpeg.stderr?.on("data", (data) => {
    console.log(`[Composite FFmpeg stderr] ${data.toString()}`);
  });

  compositeSession.ffmpeg.on("error", (err) => {
    console.error(`[Composite FFmpeg] Error: ${err.message}`);
  });

  compositeSession.ffmpeg.on("exit", (code) => {
    console.log(`[Composite FFmpeg] process exited with code ${code}`);
  });

  console.log(`Started composite FFmpeg with ${videoProducers.length} video and ${audioProducers.length} audio streams`);
}

async function cleanupCompositeSession() {
  if (!compositeSession) return;

  compositeSession.isActive = false;

  // Kill FFmpeg
  if (compositeSession.ffmpeg) {
    compositeSession.ffmpeg.kill("SIGTERM");
  }

  // Clear interval
  if (compositeSession.updateLivePlaylist) {
    clearInterval(compositeSession.updateLivePlaylist);
  }

  // Close all transports and consumers
  for (const producerInfo of compositeSession.videoProducers.values()) {
    producerInfo.consumer.close();
    producerInfo.transport.close();
  }

  for (const producerInfo of compositeSession.audioProducers.values()) {
    producerInfo.consumer.close();
    producerInfo.transport.close();
  }

  // Clean up directory
  try {
    const hlsDir = path.join(process.cwd(), "hls", compositeSession.sessionId);
    if (fs.existsSync(hlsDir)) {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error("Error cleaning up HLS directory:", error);
  }

  compositeSession = null;
  console.log("Composite session cleaned up");
}

export function getCompositeSessionInfo() {
  if (!compositeSession) return null;

  return {
    sessionId: compositeSession.sessionId,
    videoProducerCount: compositeSession.videoProducers.size,
    audioProducerCount: compositeSession.audioProducers.size,
    isActive: compositeSession.isActive,
    producers: {
      video: Array.from(compositeSession.videoProducers.keys()),
      audio: Array.from(compositeSession.audioProducers.keys()),
    }
  };
}