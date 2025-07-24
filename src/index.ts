// --- Required imports ---
import express from 'express';
import http from 'http';
import { Server as WebSocketServer } from 'ws';
import mediasoup from 'mediasoup';

// --- Server setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 3000;

// --- Mediasoup setup ---
let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;
let transports: Map<string, mediasoup.types.WebRtcTransport> = new Map();
let producers: Map<string, mediasoup.types.Producer> = new Map();
let consumers: Map<string, mediasoup.types.Consumer[]> = new Map();

async function startMediasoup() {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {},
      },
    ],
  });
  console.log('Mediasoup worker and router created');
}

startMediasoup();

// --- WebSocket signaling ---
wss.on('connection', (ws: import('ws').WebSocket) => {
  const id = Math.random().toString(36).substr(2, 9);
  console.log(`Client connected: ${id}`);

  ws.on('message', async (message: string) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch (e) {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    switch (msg.action) {
      case 'getRtpCapabilities': {
        ws.send(JSON.stringify({ action: 'rtpCapabilities', data: router.rtpCapabilities }));
        break;
      }
      case 'createTransport': {
        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp: undefined }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        });
        transports.set(id, transport);
        ws.send(JSON.stringify({
          action: 'transportCreated',
          data: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        }));
        // Handle transport events
        transport.on('dtlsstatechange', (state) => {
          if (state === 'closed') {
            transport.close();
            transports.delete(id);
          }
        });
        break;
      }
      case 'connectTransport': {
        const transport = transports.get(id);
        if (!transport) return;
        await transport.connect({ dtlsParameters: msg.data.dtlsParameters });
        ws.send(JSON.stringify({ action: 'transportConnected' }));
        break;
      }
      case 'produce': {
        const transport = transports.get(id);
        if (!transport) return;
        const producer = await transport.produce({
          kind: msg.data.kind,
          rtpParameters: msg.data.rtpParameters,
        });
        producers.set(id, producer);
        ws.send(JSON.stringify({ action: 'produced', data: { id: producer.id } }));
        // Inform all other clients about new producer
        wss.clients.forEach((client) => {
          if (client !== ws && (client as import('ws').WebSocket).readyState === 1) {
            (client as import('ws').WebSocket).send(JSON.stringify({ action: 'newProducer', data: { id } }));
          }
        });
        break;
      }
      case 'consume': {
        const transport = transports.get(id);
        if (!transport) return;
        const producerId = msg.data.producerId;
        const producer = producers.get(producerId);
        if (!producer) return;
        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: msg.data.rtpCapabilities,
          paused: false,
        });
        if (!consumers.has(id)) consumers.set(id, []);
        consumers.get(id)!.push(consumer);
        ws.send(JSON.stringify({
          action: 'consumed',
          data: {
            id: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        }));
        break;
      }
      case 'resume': {
        const consumerList = consumers.get(id) || [];
        for (const consumer of consumerList) {
          await consumer.resume();
        }
        ws.send(JSON.stringify({ action: 'resumed' }));
        break;
      }
      default:
        ws.send(JSON.stringify({ error: 'Unknown action' }));
    }
  });

  ws.on('close', () => {
    // Cleanup on disconnect
    const transport = transports.get(id);
    if (transport) transport.close();
    transports.delete(id);
    const producer = producers.get(id);
    if (producer) producer.close();
    producers.delete(id);
    const consumerList = consumers.get(id) || [];
    for (const consumer of consumerList) consumer.close();
    consumers.delete(id);
    console.log(`Client disconnected: ${id}`);
  });
});

// --- Express health check ---
app.get('/', (req: express.Request, res: express.Response) => {
  res.send('Mediasoup SFU server running');
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});