// --- Required imports ---
import express from "express";
import http from "http";
import { Server as WebSocketServer } from "ws";
import * as mediasoup from "mediasoup";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import cors from "cors";

// --- Server setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 8000;

// Enable CORS for all routes and origins
app.use(cors());

// --- Mediasoup setup ---
let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;
// Store both send and recv transports per client
let transports: Map<
  string,
  {
    send?: mediasoup.types.WebRtcTransport;
    recv?: mediasoup.types.WebRtcTransport;
  }
> = new Map();
let producers: Map<string, mediasoup.types.Producer> = new Map();
let consumers: Map<string, mediasoup.types.Consumer[]> = new Map();
// Map producer IDs to client IDs
let producerToClient: Map<string, string> = new Map();
// Track producer kinds
let producerKinds: Map<string, "audio" | "video"> = new Map();
// Track ffmpeg and transport per producer for cleanup
const producerResources: Map<string, { 
  ffmpeg: ReturnType<typeof spawn>, 
  transport: mediasoup.types.PlainTransport, 
  consumer: mediasoup.types.Consumer, 
  updateLivePlaylist: NodeJS.Timeout 
}> = new Map();

async function startMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'debug',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  });
  
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
        },
      },
      {
        kind: "video",
        mimeType: "video/VP9",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
        },
      },
      {
        kind: "video",
        mimeType: "video/h264",
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "4d0032",
          "level-asymmetry-allowed": 1,
        },
      },
    ],
  });
  console.log("Mediasoup worker and router created");
}

// Helper function to create SDP file for FFmpeg
function createSdpFile(codec: any, payloadType: number, rtpPort: number, rtcpPort: number): string {
  // Determine codec name for SDP
  let codecName = 'H264';
  let fmtp = '';

  if (codec.mimeType.toLowerCase().includes('vp8')) {
    codecName = 'VP8';
  } else if (codec.mimeType.toLowerCase().includes('vp9')) {
    codecName = 'VP9';
  } else if (codec.mimeType.toLowerCase().includes('h264')) {
    codecName = 'H264';
    // Add H.264 specific parameters
    if (codec.parameters) {
      const params = [];
      if (codec.parameters['packetization-mode']) {
        params.push(`packetization-mode=${codec.parameters['packetization-mode']}`);
      }
      if (codec.parameters['profile-level-id']) {
        params.push(`profile-level-id=${codec.parameters['profile-level-id']}`);
      }
      if (params.length > 0) {
        fmtp = `a=fmtp:${payloadType} ${params.join(';')}` + '\r\n';
      }
    }
  }

  const sdpContent = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mediasoup\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=video ${rtpPort} RTP/AVP ${payloadType}\r\na=rtpmap:${payloadType} ${codecName}/${codec.clockRate}\r\n${fmtp}a=sendonly\r\na=rtcp:${rtcpPort}\r\n`;

  return sdpContent;
}

startMediasoup();

// --- WebSocket signaling ---
wss.on("connection", (ws: import("ws").WebSocket) => {
  const id = Math.random().toString(36).substr(2, 9);
  console.log(`Client connected: ${id}`);

  ws.on("message", async (message: string) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch (e) {
      ws.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    switch (msg.action) {
      case "getRtpCapabilities": {
        ws.send(
          JSON.stringify({
            action: "rtpCapabilities",
            data: router.rtpCapabilities,
          }),
        );

        // Send existing producers to this new client
        setTimeout(() => {
          for (const [producerId, clientId] of producerToClient.entries()) {
            if (clientId !== id) {
              // Don't send own producers
              console.log(
                `Sending existing producer ${producerId} from client ${clientId} to new client ${id}`,
              );
              ws.send(
                JSON.stringify({
                  action: "newProducer",
                  data: {
                    id: producerId,
                    clientId: clientId,
                    kind: producerKinds.get(producerId),
                  },
                }),
              );
            }
          }
        }, 2000); // Increased delay to ensure client is ready
        break;
      }
      case "createTransport": {
        const type: "send" | "recv" =
          msg.data?.type === "recv" ? "recv" : "send";
        const transport = await router.createWebRtcTransport({
          // IMPORTANT: Set announcedIp to your LAN or public IP for remote access, not 127.0.0.1
          listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }], // <-- CHANGE THIS for remote/LAN use
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
        let clientTransports = transports.get(id) || {};
        clientTransports[type] = transport;
        transports.set(id, clientTransports);
        ws.send(
          JSON.stringify({
            action: "transportCreated",
            data: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
              type,
            },
          }),
        );
        // Handle transport events
        transport.on("dtlsstatechange", (state) => {
          if (state === "closed") {
            transport.close();
            if (clientTransports[type] === transport) {
              delete clientTransports[type];
              transports.set(id, clientTransports);
            }
          }
        });
        break;
      }
      case "connectTransport": {
        const type: "send" | "recv" =
          msg.data?.type === "recv" ? "recv" : "send";
        const clientTransports = transports.get(id);
        if (!clientTransports || !clientTransports[type]) return;
        await clientTransports[type]!.connect({
          dtlsParameters: msg.data.dtlsParameters,
        });
        ws.send(
          JSON.stringify({ action: "transportConnected", data: { type } }),
        );
        break;
      }
      case "produce": {
        const clientTransports = transports.get(id);
        if (!clientTransports || !clientTransports.send) return;
        const producer = await clientTransports.send.produce({
          kind: msg.data.kind,
          rtpParameters: msg.data.rtpParameters,
        });
        producers.set(producer.id, producer); // Use producer.id as key
        producerToClient.set(producer.id, id); // Map producer ID to client ID
        producerKinds.set(producer.id, msg.data.kind); // Store the kind

        console.log(
          `Client ${id} produced ${msg.data.kind} track with ID ${producer.id}`,
        );

        // --- Simplified HLS/FFmpeg bridge implementation ---
        if (msg.data.kind === "video") {
          // Clean up any previous ffmpeg/transport for this producer
          if (producerResources.has(producer.id)) {
            const { ffmpeg, transport, consumer, updateLivePlaylist } = producerResources.get(producer.id)!;
            ffmpeg.kill("SIGTERM");
            clearInterval(updateLivePlaylist);
            consumer.close();
            transport.close();
            producerResources.delete(producer.id);
          }

          try {
            // Prepare HLS output directory
            const hlsDir = path.join(process.cwd(), "hls", producer.id);
            fs.mkdirSync(hlsDir, { recursive: true });

            // Use a simpler approach: create PlainTransport that pipes to FFmpeg via stdout
            const hlsTransport = await router.createPlainTransport({
              listenIp: { ip: "127.0.0.1" },
              rtcpMux: false,
              comedia: false,
            });

            // Get random ports and connect
            const rtpPort = Math.floor(Math.random() * (65535 - 10000)) + 10000;
            const rtcpPort = rtpPort + 1;

            await hlsTransport.connect({
              ip: "127.0.0.1",
              port: rtpPort,
              rtcpPort: rtcpPort,
            });

            console.log(`PlainTransport connected to ports RTP:${rtpPort} RTCP:${rtcpPort} for producer ${producer.id}`);

            // --- DYNAMIC CODEC MATCHING ---
            // Get the producer's codec
            const prodCodec = producer.rtpParameters.codecs[0];
            // Build a valid RtpCodecCapability for the consumer
            const consumerCodec: mediasoup.types.RtpCodecCapability = {
              kind: 'video',
              mimeType: prodCodec.mimeType,
              clockRate: prodCodec.clockRate,
              preferredPayloadType: prodCodec.payloadType,
              channels: prodCodec.channels,
              parameters: prodCodec.parameters,
              rtcpFeedback: prodCodec.rtcpFeedback,
            };
            console.log(`Producer ${producer.id} codec:`, prodCodec);
            console.log(`Consumer codec for mediasoup:`, consumerCodec);

            // Create consumer with the same codec as the producer
            const hlsConsumer = await hlsTransport.consume({
              producerId: producer.id,
              rtpCapabilities: {
                codecs: [consumerCodec],
                headerExtensions: [],
              },
              paused: false,
            });

            console.log(`Created consumer for producer ${producer.id}`);
            console.log(`hlsConsumer.rtpParameters for producer ${producer.id}:`, hlsConsumer.rtpParameters);

            // --- SDP FILE GENERATION ---
            // Generate and write SDP file for FFmpeg using the consumer's codec and payload type
            const consumerRtpCodec = hlsConsumer.rtpParameters.codecs[0];
            const sdpContent = createSdpFile(
              consumerRtpCodec,
              consumerRtpCodec.payloadType,
              rtpPort,
              rtcpPort
            );
            const sdpPath = path.join(hlsDir, "stream.sdp");
            fs.writeFileSync(sdpPath, sdpContent);
            console.log(`Wrote SDP file for producer ${producer.id} at ${sdpPath}`);
            console.log(`SDP file contents for producer ${producer.id}:\n${sdpContent}`);

            // Start FFmpeg to receive from the SDP file and output HLS
            const ffmpegArgs = [
              "-protocol_whitelist", "file,udp,rtp",
              "-f", "sdp",
              "-i", sdpPath,
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
              "-bufsize", "1000k",
              "-f", "hls",
              "-hls_time", "2",
              "-hls_list_size", "5",
              "-hls_flags", "delete_segments+append_list",
              "-hls_segment_filename", path.join(hlsDir, "segment_%03d.ts"),
              path.join(hlsDir, "playlist.m3u8"),
            ];

            console.log(`Starting FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`);

            const ffmpeg = spawn("ffmpeg", ffmpegArgs, { 
              stdio: ["ignore", "pipe", "pipe"]
            });

            let hasOutput = false;

            ffmpeg.stdout?.on('data', (data) => {
              console.log(`FFmpeg stdout (${producer.id}):`, data.toString());
            });

            ffmpeg.stderr?.on('data', (data) => {
              const output = data.toString();
              
              if (output.includes('frame=') && !hasOutput) {
                hasOutput = true;
                console.log(`✅ FFmpeg receiving video frames for producer ${producer.id}`);
              }
              
              if (output.includes('Opening \'') && output.includes('.ts\'')) {
                console.log(`📦 FFmpeg creating segment for producer ${producer.id}`);
              }
              
              // Log errors
              if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
                console.error(`❌ FFmpeg error (${producer.id}):`, output.trim());
              }
            });

            ffmpeg.on('close', (code) => {
              console.log(`FFmpeg exited with code ${code} for producer ${producer.id}`);
            });

            ffmpeg.on('error', (error) => {
              console.error(`FFmpeg spawn error (${producer.id}):`, error);
            });

            // Check if we're getting data after 5 seconds
            setTimeout(() => {
              if (!hasOutput) {
                console.warn(`⚠️  No video frames received by FFmpeg for producer ${producer.id} after 5 seconds`);
              }
            }, 5000);

            // Symlink/copy the latest playlist to /hls/live/playlist.m3u8
            const liveDir = path.join(process.cwd(), "hls", "live");
            fs.mkdirSync(liveDir, { recursive: true });
            const srcPlaylist = path.join(hlsDir, "playlist.m3u8");
            const destPlaylist = path.join(liveDir, "playlist.m3u8");
            
            // Use a timer to update the live playlist every 2 seconds
            const updateLivePlaylist = setInterval(() => {
              try {
                if (fs.existsSync(srcPlaylist)) {
                  const stats = fs.statSync(srcPlaylist);
                  const lastModified = stats.mtime.getTime();
                  const now = Date.now();
                  const ageSeconds = (now - lastModified) / 1000;
                  
                  if (ageSeconds < 10) { // Only copy if recently updated
                    fs.copyFileSync(srcPlaylist, destPlaylist);
                    
                    // Also copy segment files
                    const files = fs.readdirSync(hlsDir);
                    const segments = files.filter(file => file.endsWith('.ts'));
                    
                    segments.forEach(file => {
                      const srcSegment = path.join(hlsDir, file);
                      const destSegment = path.join(liveDir, file);
                      if (fs.existsSync(srcSegment)) {
                        fs.copyFileSync(srcSegment, destSegment);
                      }
                    });
                    
                    console.log(`📋 Updated live playlist (${segments.length} segments) for producer ${producer.id}`);
                  }
                } else {
                  // Only warn occasionally to avoid spam
                  if (Math.random() < 0.1) {
                    console.log(`⚠️  Playlist not yet created for producer ${producer.id}`);
                  }
                }
              } catch (error) {
                console.error(`Error updating live playlist for producer ${producer.id}:`, error);
              }
            }, 2000);

            // Store resources for cleanup
            producerResources.set(producer.id, { 
              ffmpeg, 
              transport: hlsTransport, 
              consumer: hlsConsumer, 
              updateLivePlaylist 
            });

            // Cleanup on producer transportclose
            producer.on("transportclose", () => {
              console.log(`Cleaning up resources for producer ${producer.id}`);
              if (producerResources.has(producer.id)) {
                const { ffmpeg, transport, consumer, updateLivePlaylist } = producerResources.get(producer.id)!;
                ffmpeg.kill("SIGTERM");
                clearInterval(updateLivePlaylist);
                consumer.close();
                transport.close();
                producerResources.delete(producer.id);
                
                // Clean up files
                try {
                  if (fs.existsSync(hlsDir)) {
                    fs.rmSync(hlsDir, { recursive: true, force: true });
                  }
                } catch (error) {
                  console.error(`Error cleaning up HLS directory:`, error);
                }
              }
            });

          } catch (error) {
            console.error(`Error setting up HLS streaming for producer ${producer.id}:`, error);
          }
        }
        // --- end improved HLS/FFmpeg bridge ---

        // Handle producer closure
        producer.on("transportclose", () => {
          console.log(`Producer ${producer.id} transport closed`);
          producers.delete(producer.id);
          producerToClient.delete(producer.id);
          producerKinds.delete(producer.id);
        });
        
        ws.send(
          JSON.stringify({ action: "produced", data: { id: producer.id } }),
        );

        // Inform all other clients about new producer - send the actual producer ID
        wss.clients.forEach((client) => {
          if (
            client !== ws &&
            (client as import("ws").WebSocket).readyState === 1
          ) {
            console.log(
              `Informing client about new producer ${producer.id} of kind ${msg.data.kind}`,
            );
            (client as import("ws").WebSocket).send(
              JSON.stringify({
                action: "newProducer",
                data: {
                  id: producer.id, // Send producer ID, not client ID
                  clientId: id, // Optionally include client ID for reference
                  kind: msg.data.kind, // Include the media kind
                },
              }),
            );
          }
        });
        break;
      }
      case "consume": {
        const clientTransports = transports.get(id);
        if (!clientTransports || !clientTransports.recv) return;
        const producerId = msg.data.producerId;
        const producer = producers.get(producerId);
        if (!producer) {
          console.log(`Producer not found: ${producerId}`);
          return;
        }
        // Check if client can consume this producer
        if (
          !router.canConsume({
            producerId: producer.id,
            rtpCapabilities: msg.data.rtpCapabilities,
          })
        ) {
          console.log(`Client ${id} cannot consume producer ${producerId}`);
          return;
        }

        const consumer = await clientTransports.recv.consume({
          producerId: producer.id,
          rtpCapabilities: msg.data.rtpCapabilities,
          paused: true, // Start paused and resume after setup
        });
        
        if (!consumers.has(id)) consumers.set(id, []);
        consumers.get(id)!.push(consumer);
        
        // Handle consumer events
        consumer.on("producerclose", () => {
          console.log(`Consumer ${consumer.id} producer closed`);
          consumer.close();
          const consumerList = consumers.get(id) || [];
          const index = consumerList.findIndex((c) => c.id === consumer.id);
          if (index !== -1) {
            consumerList.splice(index, 1);
            consumers.set(id, consumerList);
          }
          // Notify client about producer closure
          ws.send(
            JSON.stringify({
              action: "producerClosed",
              data: { producerId: producer.id },
            }),
          );
        });

        ws.send(
          JSON.stringify({
            action: "consumed",
            data: {
              id: consumer.id,
              producerId: producer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              clientId: producerToClient.get(producer.id), // Add the client ID
              appData: producer.appData,
            },
          }),
        );
        break;
      }
      case "resume": {
        const consumerId = msg.data?.consumerId;
        if (consumerId) {
          // Resume specific consumer
          const consumerList = consumers.get(id) || [];
          const consumer = consumerList.find((c) => c.id === consumerId);
          if (consumer) {
            await consumer.resume();
            console.log(`Resumed consumer ${consumerId} for client ${id}`);
          }
        } else {
          // Resume all consumers for this client (fallback)
          const consumerList = consumers.get(id) || [];
          for (const consumer of consumerList) {
            await consumer.resume();
          }
          console.log(`Resumed all consumers for client ${id}`);
        }
        ws.send(JSON.stringify({ action: "resumed" }));
        break;
      }
      default:
        ws.send(JSON.stringify({ error: "Unknown action" }));
    }
  });

  ws.on("close", () => {
    // Cleanup on disconnect
    const clientTransports = transports.get(id);
    if (clientTransports) {
      if (clientTransports.send) clientTransports.send.close();
      if (clientTransports.recv) clientTransports.recv.close();
    }
    transports.delete(id);

    // Clean up producers for this client
    for (const [producerId, clientId] of producerToClient.entries()) {
      if (clientId === id) {
        const producer = producers.get(producerId);
        if (producer) {
          console.log(
            `Closing producer ${producerId} for disconnected client ${id}`,
          );
          producer.close();
        }
        producers.delete(producerId);
        producerToClient.delete(producerId);
        producerKinds.delete(producerId);

        // Clean up HLS resources
        if (producerResources.has(producerId)) {
          const { ffmpeg, transport, consumer, updateLivePlaylist } = producerResources.get(producerId)!;
          ffmpeg.kill("SIGTERM");
          clearInterval(updateLivePlaylist);
          consumer.close();
          transport.close();
          producerResources.delete(producerId);
        }

        // Notify all other clients that this producer is gone
        wss.clients.forEach((client) => {
          if ((client as import("ws").WebSocket).readyState === 1) {
            (client as import("ws").WebSocket).send(
              JSON.stringify({
                action: "producerClosed",
                data: { producerId },
              }),
            );
          }
        });
      }
    }

    const consumerList = consumers.get(id) || [];
    for (const consumer of consumerList) consumer.close();
    consumers.delete(id);
    console.log(`Client disconnected: ${id}`);
  });
});

// --- Express health check ---
app.get("/", (req: express.Request, res: express.Response) => {
  res.send("Mediasoup SFU server running");
});

// Add CORS headers for HLS content
app.use("/hls", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Serve HLS output
app.use("/hls", express.static("hls"));

// Debug endpoint to check HLS status
app.get("/debug/hls", (req, res) => {
  type HlsStatus = {
    activeProducers: string[];
    producerResources: string[];
    hlsDirectories: string[];
    livePlaylistExists: boolean;
    liveSegments: string[];
    error?: string;
  };

  const hlsStatus: HlsStatus = {
    activeProducers: Array.from(producers.keys()),
    producerResources: Array.from(producerResources.keys()),
    hlsDirectories: [],
    livePlaylistExists: false,
    liveSegments: []
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
      hlsStatus.liveSegments = fs.readdirSync(liveDir).filter(f => f.endsWith('.ts'));
    }
  } catch (error: any) {
    hlsStatus.error = error?.message || String(error);
  }

  res.json(hlsStatus);
});

// API endpoint to list active video producers
app.get("/api/active-producers", (req, res) => {
  // Only return video producers
  const videoProducers = Array.from(producers.entries())
    .filter(([id]) => producerKinds.get(id) === "video")
    .map(([id]) => id);
  res.json({ producers: videoProducers });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`HLS streams available at http://localhost:${PORT}/hls/live/playlist.m3u8`);
});