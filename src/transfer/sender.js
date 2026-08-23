import { WorkerPool } from '../workers/pool';
import { buildChunkHeader, computeFileRoot } from './protocol';

const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024; // 4MB buffer limit to prevent SCTP bufferbloat while allowing max speed
const SLEEP_MS = 2;
// UPDATE: chunked hashing removed — integrity is now a Merkle-style root
// computed from per-chunk plaintext hashes during the actual send pass.

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export class Sender {
  constructor(dataChannels, onProgress, onComplete, onError, transferId, messaging = null) {
    this.channels = dataChannels;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    // messaging: optional { send(msg) } bound to the peer chat path — used
    // for stream_end / nack / complete control messages
    this.messaging = messaging;

    // Use worker pool instead of single worker for parallel crypto
    this.pool = new WorkerPool(
      new URL('../workers/transfer.worker.js', import.meta.url),
      navigator.hardwareConcurrency
    );

    this.cancelled = false;
    this.disposed = false;
    this.failed = false;
    this.transferId = transferId || crypto.randomUUID();

    this.chunkHashMap = new Map(); // seq -> full plaintext hash
    this.localRoot = null;
    this.file = null;

    this._completeResolve = null;
    this._completePromise = new Promise((resolve) => { this._completeResolve = resolve; });

    // UPDATE 3: Throttle progress at sender — also fires window event for direct DOM updates
    this._lastProgressEmit = 0;
    this._throttledProgress = (bytes, total, seq, totalChunks) => {
      const now = performance.now();
      if (now - this._lastProgressEmit < 80) return;
      this._lastProgressEmit = now;
      // Fire as a DOM event so useTransferProgress can write directly to DOM refs (zero React re-renders)
      window.dispatchEvent(new CustomEvent('transfer_progress', {
        detail: { transferId: this.transferId, bytesTransferred: bytes, totalBytes: total, seq, totalChunks }
      }));
      this.onProgress(bytes, total, seq, totalChunks);
    };
  }

  async prepareMeta(file) {
    // Generate encryption key via worker
    const { payload: keyData } = await this.pool.request('GENERATE_KEY', {});

    const CHUNK_SIZE = 16 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const shouldCompress = this._shouldCompress(file.type);

    const meta = {
      rawKey: keyData.rawKey,
      // Whole-file hash is unknown until the send pass completes; it is
      // delivered to the receiver via the file_stream_end control message.
      fileHash: null,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      transferId: this.transferId,
      compress: shouldCompress
    };

    this.meta = meta;
    return { meta };
  }

  async _processAndSend(seq, totalChunks) {
    const CHUNK_SIZE = this.meta.chunkSize;
    const start = seq * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.file.size);
    const chunkBuffer = await this.file.slice(start, end).arrayBuffer();

    const { payload: { encrypted, chunkHash, fullChunkHash } } = await this.pool.request(
      'PROCESS_CHUNK',
      { rawKey: this.meta.rawKey, chunkBuffer, seq, compress: this.meta.compress ?? false, mimeType: this.meta.mimeType }
    );

    const wire = buildChunkHeader(seq, totalChunks, chunkHash, this.transferId, encrypted);
    await this._dispatch(wire, seq);

    this.chunkHashMap.set(seq, fullChunkHash);
  }

  async _dispatch(wire, seq) {
    const channel = this.channels[seq % this.channels.length];

    // Backpressure: wait if buffer is full (real DataChannels only)
    let guard = 0;
    while (
      typeof channel.bufferedAmount === 'number' &&
      channel.bufferedAmount > BACKPRESSURE_THRESHOLD &&
      !this.cancelled
    ) {
      await sleep(SLEEP_MS);
      if (++guard > 15000) throw new Error('Send channel stalled (backpressure timeout)');
    }

    if (this.cancelled) throw new Error('Transfer cancelled');

    const result = channel.send(wire);
    // Relay mock channels return promises — surface upload failures and stop
    if (result && typeof result.catch === 'function') {
      await result;
    }
  }

  async send(file) {
    try {
      if (!this.meta) await this.prepareMeta(file);
      this.file = file;

      const totalChunks = this.meta.totalChunks;
      let bytesSent = 0;

      for (let seq = 0; seq < totalChunks; seq++) {
        if (this.cancelled) break;
        await this._processAndSend(seq, totalChunks);
        bytesSent += Math.min(this.meta.chunkSize, file.size - seq * this.meta.chunkSize);
        this._throttledProgress(bytesSent, file.size, seq + 1, totalChunks);
      }

      if (!this.cancelled) {
        this.localRoot = await this._computeRoot();
        this._sendControl({
          type: 'file_stream_end',
          transferId: this.transferId,
          fileHash: this.localRoot
        });
      }
    } catch (err) {
      this.failed = true;
      if (!this.cancelled) this.onError(err);
    }
  }

  async _computeRoot() {
    return computeFileRoot(this.chunkHashMap, this.meta.totalChunks);
  }

  // ── Control plane (chat path): nacks + completion acks ──

  _sendControl(msg) {
    if (this.messaging) {
      Promise.resolve(this.messaging.send(msg)).catch(() => {});
    }
  }

  async handleControlMessage(msg) {
    if (!msg || msg.transferId !== this.transferId || this.cancelled || this.disposed) return;

    if (msg.type === 'file_nack' && Array.isArray(msg.seqs) && !this.failed) {
      try {
        for (const seq of msg.seqs) {
          if (seq >= 0 && seq < this.meta.totalChunks) {
            await this._processAndSend(seq, this.meta.totalChunks); // fresh IV, same plaintext hash
          }
        }
      } catch (err) {
        this.failed = true;
        if (!this.cancelled) this.onError(err);
        return;
      }
      this._sendControl({
        type: 'file_stream_end',
        transferId: this.transferId,
        fileHash: this.localRoot
      });
    }

    if (msg.type === 'file_complete') {
      this._completeResolve(msg.root || null);
    }
  }

  /** Resolves with receiver's computed root, or null on timeout */
  waitComplete(timeoutMs = 45000) {
    const timer = setTimeout(() => this._completeResolve(null), timeoutMs);
    return this._completePromise.then((root) => {
      clearTimeout(timer);
      return root;
    });
  }

  _shouldCompress(mimeType) {
    if (!mimeType) return false;
    const noCompress = ['image/', 'video/', 'audio/', 'zip', 'gz', 'rar', '7z'];
    return !noCompress.some(t => mimeType.includes(t));
  }

  cancel() {
    this.cancelled = true;
    this._completeResolve(null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.terminate();
    this.chunkHashMap.clear();
    this.file = null;
  }
}
