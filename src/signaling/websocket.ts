import { Server as WebSocketServer } from "ws";
import { getRouter } from "../mediasoup/worker";
import * as mediasoup from "mediasoup";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { setupHlsFfmpegBridge } from "../ffmpeg/ffmpegBridge";

export function setupWebSocketSignaling(server: any, {
  transports,
  producers,
  consumers,
  producerToClient,
  producerKinds,
  producerResources,
  createSdpFile
}: {
  transports: Map<string, { send?: mediasoup.types.WebRtcTransport; recv?: mediasoup.types.WebRtcTransport }>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer[]>;
  producerToClient: Map<string, string>;
  producerKinds: Map<string, "audio" | "video">;
  producerResources: Map<string, { ffmpeg: ReturnType<typeof spawn>, transports: mediasoup.types.PlainTransport[], consumers: mediasoup.types.Consumer[], updateLivePlaylist: NodeJS.Timeout }>;
  createSdpFile: Function;
}) {
  const wss = new WebSocketServer({ server });

  // Track both audio and video producers per client
  const clientProducers: Map<string, { video?: mediasoup.types.Producer, audio?: mediasoup.types.Producer }> = new Map();

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
              data: getRouter().rtpCapabilities,
            }),
          );

          setTimeout(() => {
            for (const [producerId, clientId] of producerToClient.entries()) {
              if (clientId !== id) {
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
          }, 2000);
          break;
        }
        case "createTransport": {
          const type: "send" | "recv" =
            msg.data?.type === "recv" ? "recv" : "send";
          const transport = await getRouter().createWebRtcTransport({
            listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
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
          producers.set(producer.id, producer);
          producerToClient.set(producer.id, id);
          producerKinds.set(producer.id, msg.data.kind);

          // Track audio/video producers for this client
          let entry = clientProducers.get(id) || {};
          if (msg.data.kind === "video") entry.video = producer;
          if (msg.data.kind === "audio") entry.audio = producer;
          clientProducers.set(id, entry);

          // If either audio or video is produced, try to start HLS/FFmpeg bridge
          if (entry.video || entry.audio) {
            // Use video producer ID as session ID if present, else audio
            try {
              await setupHlsFfmpegBridge({
                videoProducer: entry.video || null,
                audioProducer: entry.audio || null,
                getRouter,
                producerResources,
                createSdpFile
              });
            } catch (error) {}
          }

          producer.on("transportclose", () => {
            producers.delete(producer.id);
            producerToClient.delete(producer.id);
            producerKinds.delete(producer.id);
            // Remove from clientProducers
            let entry = clientProducers.get(id) || {};
            if (msg.data.kind === "video") delete entry.video;
            if (msg.data.kind === "audio") delete entry.audio;
            clientProducers.set(id, entry);
          });
          ws.send(
            JSON.stringify({ action: "produced", data: { id: producer.id } }),
          );
          wss.clients.forEach((client) => {
            if (
              client !== ws &&
              (client as import("ws").WebSocket).readyState === 1
            ) {
              (client as import("ws").WebSocket).send(
                JSON.stringify({
                  action: "newProducer",
                  data: {
                    id: producer.id,
                    clientId: id,
                    kind: msg.data.kind,
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
            return;
          }
          if (
            !getRouter().canConsume({
              producerId: producer.id,
              rtpCapabilities: msg.data.rtpCapabilities,
            })
          ) {
            return;
          }
          const consumer = await clientTransports.recv.consume({
            producerId: producer.id,
            rtpCapabilities: msg.data.rtpCapabilities,
            paused: true,
          });
          if (!consumers.has(id)) consumers.set(id, []);
          consumers.get(id)!.push(consumer);
          consumer.on("producerclose", () => {
            consumer.close();
            const consumerList = consumers.get(id) || [];
            const index = consumerList.findIndex((c) => c.id === consumer.id);
            if (index !== -1) {
              consumerList.splice(index, 1);
              consumers.set(id, consumerList);
            }
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
                clientId: producerToClient.get(producer.id),
                appData: producer.appData,
              },
            }),
          );
          break;
        }
        case "resume": {
          const consumerId = msg.data?.consumerId;
          if (consumerId) {
            const consumerList = consumers.get(id) || [];
            const consumer = consumerList.find((c) => c.id === consumerId);
            if (consumer) {
              await consumer.resume();
            }
          } else {
            const consumerList = consumers.get(id) || [];
            for (const consumer of consumerList) {
              await consumer.resume();
            }
          }
          ws.send(JSON.stringify({ action: "resumed" }));
          break;
        }
        default:
          ws.send(JSON.stringify({ error: "Unknown action" }));
      }
    });

    ws.on("close", () => {
      const clientTransports = transports.get(id);
      if (clientTransports) {
        if (clientTransports.send) clientTransports.send.close();
        if (clientTransports.recv) clientTransports.recv.close();
      }
      transports.delete(id);
      for (const [producerId, clientId] of producerToClient.entries()) {
        if (clientId === id) {
          const producer = producers.get(producerId);
          if (producer) {
            producer.close();
          }
          producers.delete(producerId);
          producerToClient.delete(producerId);
          producerKinds.delete(producerId);
          if (producerResources.has(producerId)) {
            const { ffmpeg, transports, consumers, updateLivePlaylist } = producerResources.get(producerId)!;
            ffmpeg.kill("SIGTERM");
            clearInterval(updateLivePlaylist);
            consumers.forEach(c => c.close());
            transports.forEach(t => t.close());
            producerResources.delete(producerId);
          }
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
    });
  });
} 