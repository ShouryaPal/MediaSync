import express from "express";
import http from "http";
import * as mediasoup from "mediasoup";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import cors from "cors";
import { startMediasoup, getRouter } from "./mediasoup/worker";
import { setupWebSocketSignaling } from "./signaling/websocket";
import { getCompositeSessionInfo } from "./ffmpeg/compositeFFmpegBridge";

const app = express();
const server = http.createServer(app);
const PORT = 8000;

app.use(cors());
app.use(express.json());

let transports: Map<
  string,
  {
    send?: mediasoup.types.WebRtcTransport;
    recv?: mediasoup.types.WebRtcTransport;
  }
> = new Map();
let producers: Map<string, mediasoup.types.Producer> = new Map();
let consumers: Map<string, mediasoup.types.Consumer[]> = new Map();

let producerToClient: Map<string, string> = new Map();

let producerKinds: Map<string, "audio" | "video"> = new Map();

const producerResources: Map<
  string,
  {
    ffmpeg: ReturnType<typeof spawn>;
    transports: mediasoup.types.PlainTransport[];
    consumers: mediasoup.types.Consumer[];
    updateLivePlaylist: NodeJS.Timeout;
  }
> = new Map();

startMediasoup();

function createSdpFile(
  codec: any,
  payloadType: number,
  rtpPort: number,
  rtcpPort: number,
): string {
  const mime = codec.mimeType.toLowerCase();
  let isAudio = mime.includes("audio");
  let isVideo = mime.includes("video");
  let codecName = "";
  let fmtp = "";
  let channels = codec.channels || 2;

  if (isAudio) {
    if (mime.includes("opus")) {
      codecName = "OPUS";
    } else if (mime.includes("aac")) {
      codecName = "MPEG4-GENERIC";

      if (codec.parameters) {
        const params = [];
        if (codec.parameters["profile-level-id"]) {
          params.push(
            `profile-level-id=${codec.parameters["profile-level-id"]}`,
          );
        }
        if (params.length > 0) {
          fmtp = `a=fmtp:${payloadType} ${params.join(";")}` + "\r\n";
        }
      }
    } else {
      codecName = codec.mimeType.split("/")[1].toUpperCase();
    }
  } else if (isVideo) {
    if (mime.includes("vp8")) {
      codecName = "VP8";
    } else if (mime.includes("vp9")) {
      codecName = "VP9";
    } else if (mime.includes("h264")) {
      codecName = "H264";

      if (codec.parameters) {
        const params = [];
        if (codec.parameters["packetization-mode"]) {
          params.push(
            `packetization-mode=${codec.parameters["packetization-mode"]}`,
          );
        }
        if (codec.parameters["profile-level-id"]) {
          params.push(
            `profile-level-id=${codec.parameters["profile-level-id"]}`,
          );
        }
        if (params.length > 0) {
          fmtp = `a=fmtp:${payloadType} ${params.join(";")}` + "\r\n";
        }
      }
    } else {
      codecName = codec.mimeType.split("/")[1].toUpperCase();
    }
  }

  let mline = "";
  if (isAudio) {
    mline = `m=audio ${rtpPort} RTP/AVP ${payloadType}\r\na=rtpmap:${payloadType} ${codecName}/${codec.clockRate}/${channels}\r\n`;
  } else if (isVideo) {
    mline = `m=video ${rtpPort} RTP/AVP ${payloadType}\r\na=rtpmap:${payloadType} ${codecName}/${codec.clockRate}\r\n`;
  }

  return `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mediasoup\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n${mline}${fmtp}a=sendonly\r\na=rtcp:${rtcpPort}\r\n`;
}

setupWebSocketSignaling(server, {
  transports,
  producers,
  consumers,
  producerToClient,
  producerKinds,
  producerResources,
  createSdpFile,
});

app.get("/", (req: express.Request, res: express.Response) => {
  res.send("Mediasoup SFU server with Composite Streaming running");
});

app.use("/hls", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  next();
});

app.use("/hls", express.static("hls"));

app.get("/debug/hls", (req, res) => {
  type HlsStatus = {
    activeProducers: string[];
    producerResources: string[];
    hlsDirectories: string[];
    livePlaylistExists: boolean;
    liveSegments: string[];
    compositeInfo: any;
    error?: string;
  };

  const hlsStatus: HlsStatus = {
    activeProducers: Array.from(producers.keys()),
    producerResources: Array.from(producerResources.keys()),
    hlsDirectories: [],
    livePlaylistExists: false,
    liveSegments: [],
    compositeInfo: getCompositeSessionInfo(),
  };

  try {
    const hlsDir = path.join(process.cwd(), "hls");
    if (fs.existsSync(hlsDir)) {
      hlsStatus.hlsDirectories = fs.readdirSync(hlsDir);
    }

    const liveDir = path.join(process.cwd(), "hls", "live");
    const livePlaylist = path.join(liveDir, "playlist.m3u8");
    hlsStatus.livePlaylistExists = fs.existsSync(livePlaylist);

    if (fs.existsSync(liveDir)) {
      hlsStatus.liveSegments = fs
        .readdirSync(liveDir)
        .filter((f) => f.endsWith(".ts"));
    }
  } catch (error: any) {
    hlsStatus.error = error?.message || String(error);
  }

  res.json(hlsStatus);
});

app.get("/api/active-producers", (req, res) => {
  const videoProducers = Array.from(producers.entries())
    .filter(([id]) => producerKinds.get(id) === "video")
    .map(([id]) => id);
  res.json({ producers: videoProducers });
});

app.get("/api/composite-info", (req, res) => {
  const compositeInfo = getCompositeSessionInfo();
  res.json({
    composite: compositeInfo,
    totalProducers: producers.size,
    activeClients: transports.size,
  });
});

app.get("/api/stream-urls", (req, res) => {
  const baseUrl = `http://localhost:${PORT}`;
  const compositeInfo = getCompositeSessionInfo();
  
  type StreamUrls = {
    composite: string | null;
    individual: Array<{
      producerId: string;
      url: string;
    }>;
  };
  
  const streamUrls: StreamUrls = {
    composite: compositeInfo ? `${baseUrl}/hls/live/playlist.m3u8` : null,
    individual: [],
  };

  // Add individual stream URLs if they exist
  const hlsDir = path.join(process.cwd(), "hls");
  try {
    if (fs.existsSync(hlsDir)) {
      const directories = fs.readdirSync(hlsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && dirent.name !== 'live')
        .map(dirent => dirent.name);
      
      streamUrls.individual = directories.map(dir => ({
        producerId: dir,
        url: `${baseUrl}/hls/${dir}/playlist.m3u8`
      }));
    }
  } catch (error) {
    console.error("Error reading HLS directories:", error);
  }

  res.json(streamUrls);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    activeProducers: producers.size,
    activeClients: transports.size,
    compositeActive: !!getCompositeSessionInfo(),
    timestamp: new Date().toISOString(),
  });
});

// Stats endpoint
app.get("/api/stats", (req, res) => {
  const stats = {
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    },
    mediasoup: {
      activeProducers: producers.size,
      activeConsumers: Array.from(consumers.values()).reduce((total, consumerList) => total + consumerList.length, 0),
      activeTransports: transports.size,
    },
    streaming: {
      composite: getCompositeSessionInfo(),
      individualStreams: producerResources.size,
    }
  };

  res.json(stats);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Individual HLS streams available at http://localhost:${PORT}/hls/[producer-id]/playlist.m3u8`);
  console.log(`Composite HLS stream available at http://localhost:${PORT}/hls/live/playlist.m3u8`);
  console.log(`API endpoints:`);
  console.log(`  - GET /api/composite-info - Get composite stream information`);
  console.log(`  - GET /api/stream-urls - Get all available stream URLs`);
  console.log(`  - GET /api/stats - Get server statistics`);
  console.log(`  - GET /health - Health check`);
  console.log(`  - GET /debug/hls - Debug HLS status`);
});