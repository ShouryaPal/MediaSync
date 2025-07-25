// --- Required imports ---
import express from "express";
import http from "http";
import { Server as WebSocketServer } from "ws";
import * as mediasoup from "mediasoup";

// --- Server setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 8000;

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

async function startMediasoup() {
  worker = await mediasoup.createWorker();
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
          // iceServers is NOT a valid option for mediasoup WebRtcTransport
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

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
