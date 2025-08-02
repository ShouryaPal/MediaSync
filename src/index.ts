import express from "express";
import http from "http";
import * as mediasoup from "mediasoup";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import cors from "cors";
import { startMediasoup, getRouter } from "./mediasoup/worker";
import { setupWebSocketSignaling } from "./signaling/websocket";

const app = express();
const server = http.createServer(app);
const PORT = 8000;

app.use(cors());

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

export function createSdpFile(
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
  res.send("Mediasoup SFU server running");
});

app.use("/hls", express.static("hls", {
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.m3u8')) {
      res.header('Content-Type', 'application/x-mpegURL');
    } else if (path.endsWith('.ts')) {
      res.header('Content-Type', 'video/MP2T');
    }
  },
}));

app.get("/debug/hls", (req, res) => {
  type HlsStatus = {
    activeProducers: string[];
    producerResources: string[];
    hlsDirectories: string[];
    livePlaylistExists: boolean;
    liveSegments: string[];
    combinedStreamExists: boolean;
    error?: string;
  };

  const hlsStatus: HlsStatus = {
    activeProducers: Array.from(producers.keys()),
    producerResources: Array.from(producerResources.keys()),
    hlsDirectories: [],
    livePlaylistExists: false,
    liveSegments: [],
    combinedStreamExists: false,
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

    // Check if combined stream exists
    const combinedDir = path.join(process.cwd(), "hls", "combined");
    const combinedPlaylist = path.join(combinedDir, "playlist.m3u8");
    hlsStatus.combinedStreamExists = fs.existsSync(combinedPlaylist);
  } catch (error: any) {
    hlsStatus.error = error?.message || String(error);
  }

  res.json(hlsStatus);
});

app.get("/api/active-producers", (req, res) => {
  const videoProducers = Array.from(producers.entries())
    .filter(([id]) => producerKinds.get(id) === "video")
    .map(([id]) => id);
  res.json({
    producers: videoProducers,
    hasCombinedStream: producerResources.has("combined-stream"),
  });
});

// New endpoint to check if combined stream is available
app.get("/api/combined-stream-status", (req, res) => {
  const combinedDir = path.join(process.cwd(), "hls", "combined");
  const combinedPlaylist = path.join(combinedDir, "playlist.m3u8");
  const liveDir = path.join(process.cwd(), "hls", "live");
  const livePlaylist = path.join(liveDir, "playlist.m3u8");

  res.json({
    combinedAvailable: fs.existsSync(combinedPlaylist),
    liveAvailable: fs.existsSync(livePlaylist),
    activeVideoProducers: Array.from(producers.entries()).filter(
      ([id]) => producerKinds.get(id) === "video",
    ).length,
    ffmpegRunning: producerResources.has("combined-stream"),
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(
    `Combined HLS stream available at http://localhost:${PORT}/hls/combined/playlist.m3u8`,
  );
  console.log(`Debug endpoint available at http://localhost:${PORT}/debug/hls`);
});
