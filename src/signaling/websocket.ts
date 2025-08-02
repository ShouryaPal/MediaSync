import { Server as WebSocketServer } from "ws";
import { getRouter } from "../mediasoup/worker";
import * as mediasoup from "mediasoup";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { setupCombinedHlsStream } from "../ffmpeg/combinedHLSBridge";

interface ProducerSession {
  videoProducer?: mediasoup.types.Producer;
  audioProducer?: mediasoup.types.Producer;
  clientId: string;
}

export function setupWebSocketSignaling(
  server: any,
  {
    transports,
    producers,
    consumers,
    producerToClient,
    producerKinds,
    producerResources,
    createSdpFile,
  }: {
    transports: Map<
      string,
      {
        send?: mediasoup.types.WebRtcTransport;
        recv?: mediasoup.types.WebRtcTransport;
      }
    >;
    producers: Map<string, mediasoup.types.Producer>;
    consumers: Map<string, mediasoup.types.Consumer[]>;
    producerToClient: Map<string, string>;
    producerKinds: Map<string, "audio" | "video">;
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
  },
) {
  const wss = new WebSocketServer({ server });

  // Track both audio and video producers per client
  const clientProducers: Map<string, ProducerSession> = new Map();

  // Function to update combined stream when producers change
  const updateCombinedStream = async () => {
    console.log("Updating combined stream...");
    const activeSessions = new Map<string, ProducerSession>();

    // Get all sessions with video producers
    for (const [clientId, session] of clientProducers) {
      if (session.videoProducer) {
        activeSessions.set(clientId, session);
      }
    }

    console.log(`Found ${activeSessions.size} active video sessions`);

    try {
      await setupCombinedHlsStream({
        sessions: activeSessions,
        getRouter,
        producerResources,
      });
    } catch (error) {
      console.error("Error updating combined stream:", error);
    }
  };

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
          let entry = clientProducers.get(id) || { clientId: id };
          if (msg.data.kind === "video") {
            entry.videoProducer = producer;
          }
          if (msg.data.kind === "audio") {
            entry.audioProducer = producer;
          }
          clientProducers.set(id, entry);

          // Update combined stream when we have video producers
          if (msg.data.kind === "video") {
            console.log("Video producer added, updating combined stream");
            setTimeout(() => updateCombinedStream(), 1000);
          }

          producer.on("transportclose", () => {
            console.log(`Producer ${producer.id} transport closed`);
            producers.delete(producer.id);
            producerToClient.delete(producer.id);
            producerKinds.delete(producer.id);

            // Remove from clientProducers
            let entry = clientProducers.get(id);
            if (entry) {
              if (msg.data.kind === "video") {
                delete entry.videoProducer;
              }
              if (msg.data.kind === "audio") {
                delete entry.audioProducer;
              }

              // If no producers left, remove the entry
              if (!entry.videoProducer && !entry.audioProducer) {
                clientProducers.delete(id);
              } else {
                clientProducers.set(id, entry);
              }

              // Update combined stream when video producer is removed
              if (msg.data.kind === "video") {
                console.log("Video producer removed, updating combined stream");
                setTimeout(() => updateCombinedStream(), 1000);
              }
            }
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
      console.log(`Client ${id} disconnected`);
      const clientTransports = transports.get(id);
      if (clientTransports) {
        if (clientTransports.send) clientTransports.send.close();
        if (clientTransports.recv) clientTransports.recv.close();
      }
      transports.delete(id);

      // Clean up producers for this client
      const hadVideoProducer =
        clientProducers.has(id) && clientProducers.get(id)?.videoProducer;

      for (const [producerId, clientId] of producerToClient.entries()) {
        if (clientId === id) {
          const producer = producers.get(producerId);
          if (producer) {
            producer.close();
          }
          producers.delete(producerId);
          producerToClient.delete(producerId);
          producerKinds.delete(producerId);

          // Clean up individual producer resources (from old system)
          if (producerResources.has(producerId)) {
            const { ffmpeg, transports, consumers, updateLivePlaylist } =
              producerResources.get(producerId)!;
            ffmpeg.kill("SIGTERM");
            clearInterval(updateLivePlaylist);
            consumers.forEach((c) => c.close());
            transports.forEach((t) => t.close());
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

      // Remove client from tracking
      clientProducers.delete(id);

      // Update combined stream if this client had a video producer
      if (hadVideoProducer) {
        console.log(
          "Client with video producer disconnected, updating combined stream",
        );
        setTimeout(() => updateCombinedStream(), 1000);
      }

      const consumerList = consumers.get(id) || [];
      for (const consumer of consumerList) consumer.close();
      consumers.delete(id);
    });
  });
}
