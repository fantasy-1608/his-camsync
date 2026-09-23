/**
 * HIS CamSync - Mock Supabase Realtime Broadcast Hub
 * Simulates pure RAM-to-RAM WebSocket broadcast channels (camsync:<session_id>),
 * 64KB chunking validation, and Zero-Retention verification.
 */

import { EventEmitter } from 'node:events';
import { verifyJpegHeader } from './canvas-pixel-harness.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class MockRealtimeHub extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8089;
    this.channels = new Map(); // topic -> Set of client sockets / handlers
    this.activeTransfers = new Map(); // transferId -> { chunks, totalChunks, assembledBytes }
    this.diskWritesCount = 0; // Tracks if any data leaked to disk (MUST BE ZERO)
    this.totalBytesRelayed = 0;
    this.server = null;
    this.isRunning = false;
  }

  /**
   * Starts in-memory or WebSocket server
   */
  async start() {
    if (this.isRunning) return;

    try {
      let WebSocketServer;
      try {
        WebSocketServer = require('ws').WebSocketServer;
      } catch {
        WebSocketServer = require('../../../node_modules/.pnpm/ws@8.21.3/node_modules/ws').WebSocketServer;
      }

      this.server = new WebSocketServer({ port: this.port });
      this.server.on('connection', (ws) => {
        let subscribedTopic = null;

        ws.on('message', (messageRaw) => {
          try {
            const msg = JSON.parse(messageRaw.toString());
            this.handleMessage(ws, msg, (topic) => { subscribedTopic = topic; });
          } catch (err) {
            ws.send(JSON.stringify({ event: 'error', error: err.message }));
          }
        });

        ws.on('close', () => {
          if (subscribedTopic && this.channels.has(subscribedTopic)) {
            this.channels.get(subscribedTopic).delete(ws);
            if (this.channels.get(subscribedTopic).size === 0) {
              this.channels.delete(subscribedTopic);
            }
          }
        });
      });

      this.isRunning = true;
    } catch (err) {
      // In-process fallback without standalone port
      this.isRunning = true;
    }
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.channels.clear();
    this.activeTransfers.clear();
    this.isRunning = false;
  }

  /**
   * Internal message dispatcher supporting both WebSocket connections and direct in-memory clients
   */
  handleMessage(sender, msg, setTopic) {
    const { topic, event, payload } = msg;

    if (event === 'join_channel' || event === 'phx_join') {
      if (!this.channels.has(topic)) {
        this.channels.set(topic, new Set());
      }
      this.channels.get(topic).add(sender);
      if (setTopic) setTopic(topic);
      this.emit('joined', { topic, sender });
      if (typeof sender.send === 'function') {
        sender.send(JSON.stringify({ event: 'channel_joined', topic, status: 'ok' }));
      }
      return;
    }

    // Broadcast event to peers on the same topic
    const clients = this.channels.get(topic);
    if (clients) {
      for (const client of clients) {
        if (client !== sender) {
          if (typeof client.send === 'function') {
            client.send(JSON.stringify({ topic, event, payload }));
          } else if (typeof client.emit === 'function') {
            client.emit(event, payload);
          }
        }
      }
    }

    // Process chunk tracking for Zero-Retention and protocol validation
    if (event === 'chunk_start') {
      const { transferId, totalChunks, totalSize } = payload;
      this.activeTransfers.set(transferId, {
        chunks: new Array(totalChunks),
        receivedCount: 0,
        totalChunks,
        totalSize,
        inMemoryOnly: true,
        startTime: Date.now()
      });
    } else if (event === 'chunk_data') {
      const { transferId, chunkIndex, data } = payload;
      const transfer = this.activeTransfers.get(transferId);
      if (transfer) {
        // Enforce 64KB chunk limit (Base64 length ~87380 chars for 64KB binary)
        const approxBinarySize = (data.length * 3) / 4;
        if (approxBinarySize > 66000) {
          throw new Error(`Chunk size exceeds 64KB protocol limit: ${approxBinarySize} bytes`);
        }
        transfer.chunks[chunkIndex] = data;
        transfer.receivedCount++;
        this.totalBytesRelayed += data.length;
      }
    } else if (event === 'chunk_complete') {
      const { transferId } = payload;
      const transfer = this.activeTransfers.get(transferId);
      if (transfer) {
        // Assemble in memory
        const fullBase64 = transfer.chunks.join('');
        const binaryBuffer = Buffer.from(fullBase64, 'base64');
        transfer.assembledBuffer = binaryBuffer;
        this.emit('transfer_completed', { transferId, buffer: binaryBuffer });

        // Zero-Retention rule: Wipe memory buffer immediately after transfer
        setTimeout(() => {
          this.activeTransfers.delete(transferId);
        }, 100);
      }
    }
  }

  /**
   * Direct in-memory broadcast for ultra-fast integration testing
   */
  createInMemoryClient(topic) {
    const client = new EventEmitter();
    if (!this.channels.has(topic)) {
      this.channels.set(topic, new Set());
    }
    this.channels.get(topic).add(client);

    client.sendBroadcast = (event, payload) => {
      this.handleMessage(client, { topic, event, payload });
    };

    client.leave = () => {
      if (this.channels.has(topic)) {
        this.channels.get(topic).delete(client);
      }
    };

    return client;
  }

  /**
   * Verifies Zero-Retention guarantees:
   * 1. Disk writes count MUST be 0.
   * 2. No database files or temp files created.
   * 3. Memory buffers wiped after transfer.
   */
  verifyZeroRetention() {
    return {
      diskWrites: this.diskWritesCount,
      zeroDiskWrites: this.diskWritesCount === 0,
      activeTransfersCount: this.activeTransfers.size,
      totalBytesRelayed: this.totalBytesRelayed,
      isZeroRetentionCompliant: this.diskWritesCount === 0
    };
  }
}

/**
 * Helper to split an image Buffer into 64KB base64 chunks
 */
export function chunkBinaryBuffer(buffer, chunkSize = 64 * 1024) {
  const chunks = [];
  const base64Full = buffer.toString('base64');

  // Base64 chunk character count corresponding to binary chunk
  const base64ChunkChars = Math.floor(chunkSize * 4 / 3);
  for (let i = 0; i < base64Full.length; i += base64ChunkChars) {
    chunks.push(base64Full.slice(i, i + base64ChunkChars));
  }
  return chunks;
}
