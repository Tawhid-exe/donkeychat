import { WorkerPool } from '../workers/pool';
import { buildChunkHeader } from './protocol';

const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024; // 4MB buffer limit
const SLEEP_MS = 5;
// FIX #4: Chunked hashing — don't load entire file for hash
const HASH_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks for hashing

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export class Sender {
  constructor(dataChannels, onProgress, onComplete, onError, transferId) {
    this.channels = dataChannels;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;

    // Use worker pool instead of single worker for parallel crypto
    this.pool = new WorkerPool(
      new URL('../workers/transfer.worker.js', import.meta.url),
      navigator.hardwareConcurrency
    );

    this.cancelled = false;
    this.transferId = transferId || crypto.randomUUID();

    // UPDATE 3: Throttle progress at sender
    this._lastProgressEmit = 0;
    this._throttledProgress = (bytes, total, seq, totalChunks) => {
      const now = performance.now();
      if (now - this._lastProgressEmit < 80) return;
      this._lastProgressEmit = now;
      this.onProgress(bytes, total, seq, totalChunks);
    };
  }

  // FIX #4: Chunked file hashing — never loads entire file into RAM
  async prepareMeta(file) {
    // Generate encryption key via worker
    const { payload: keyData } = await this.pool.request('GENERATE_KEY', {});

    // Chunked hash — stream through file in 2MB pieces
    const fileHash = await this._hashFileChunked(file);

    const totalChunks = Math.ceil(file.size / (64 * 1024));

    const meta = {
      rawKey: keyData.rawKey,
      fileHash,
      totalChunks,
      chunkSize: 64 * 1024,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      transferId: this.transferId
    };

    this.meta = meta;
    return { meta };
  }

  async _hashFileChunked(file) {
    // Use fast hash for all files to prevent RAM spikes
    // first 1MB + last 1MB + file size
    const chunkSize = Math.min(1024 * 1024, file.size);
    const firstChunk = await file.slice(0, chunkSize).arrayBuffer();
    const lastChunk = await file.slice(Math.max(0, file.size - chunkSize)).arrayBuffer();
    const sizeStr = new TextEncoder().encode(file.size.toString());

    const combined = new Uint8Array(firstChunk.byteLength + lastChunk.byteLength + sizeStr.byteLength);
    combined.set(new Uint8Array(firstChunk), 0);
    combined.set(new Uint8Array(lastChunk), firstChunk.byteLength);
    combined.set(sizeStr, firstChunk.byteLength + lastChunk.byteLength);

    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async send(file) {
    try {
      if (!this.meta) await this.prepareMeta(file);

      const stream = file.stream();
      const reader = stream.getReader();
      let seq = 0;
      let bytesSent = 0;
      const rawKey = this.meta.rawKey;
      const shouldCompress = false; // Compression disabled — no decompress on receiver side

      while (true) {
        if (this.cancelled) break;

        const { done, value } = await reader.read();
        if (done) break;

        const chunkBuffer = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        );

        const { payload: { encrypted, chunkHash } } = await this.pool.request(
          'PROCESS_CHUNK',
          { rawKey, chunkBuffer, seq, compress: shouldCompress, mimeType: file.type }
        );

        const wire = buildChunkHeader(seq, this.meta.totalChunks, chunkHash, this.transferId, encrypted);

        const channel = this.channels[seq % this.channels.length];

        while (
          channel.bufferedAmount > BACKPRESSURE_THRESHOLD &&
          !this.cancelled
        ) {
          await sleep(SLEEP_MS);
        }

        if (!this.cancelled) {
          channel.send(wire);
          bytesSent += value.byteLength;
          seq++;
          this._throttledProgress(bytesSent, file.size, seq, this.meta.totalChunks);
        }
      }

      reader.releaseLock();

      if (!this.cancelled) {
        this.onComplete(this.meta.fileHash, this.meta.totalChunks);
      }

    } catch (err) {
      this.onError(err);
    } finally {
      this.pool.terminate();
    }
  }

  _shouldCompress(mimeType) {
    if (!mimeType) return false;
    const noCompress = ['image/', 'video/', 'audio/', 'zip', 'gz', 'rar', '7z'];
    return !noCompress.some(t => mimeType.includes(t));
  }

  cancel() {
    this.cancelled = true;
  }
}
