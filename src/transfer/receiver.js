import { WorkerPool } from '../workers/pool';
import { parseChunkHeader, computeFileRoot } from './protocol';
import { activityLog } from '../utils/activityLog';

const MAX_NACK_ROUNDS = 5;
const ROOT_WAIT_MS = 15000;
const STREAM_SETTLE_MS = 1500;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export class Receiver {
  constructor(meta, onProgress, onComplete, onError, messaging = null) {
    this.meta = meta;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    // messaging: optional { send(msg) } bound to the peer chat path — used
    // for nack requests and the file_complete ack
    this.messaging = messaging;

    this.cryptoPool = new WorkerPool(
      new URL('../workers/transfer.worker.js', import.meta.url)
    );

    this.receiverWorker = new Worker(
      new URL('../workers/receiver.worker.js', import.meta.url),
      { type: 'module' }
    );

    this.receivedCount = 0;
    this.bytesReceived = 0;
    this.writerMode = null;

    // Integrity state
    this.chunkHashMap = new Map();   // seq -> full plaintext hash of valid chunks
    this.expectedRoot = meta.fileHash || null; // arrives via file_stream_end
    this.nackRounds = 0;
    this.pullMode = false;           // set true for Tier 3/4 sequential pulls
    this.done = false;
    this.cancelled = false;
    this._opfsWritten = false;
    this._finalizing = false;

    this.fsaWritable = null;

    this.blobChunks = new Map();
    this.BLOB_SIZE_LIMIT = 500 * 1024 * 1024;
  }

  async init(userGesture = false) {
    this.writerMode = await this._detectWriterMode(userGesture);

    if (this.writerMode === 'fsa' && this.meta.fileSize > 2 * 1024 * 1024 * 1024) {
      this.writerMode = 'opfs';
    }

    if (this.writerMode === 'blob' && this.meta.fileSize > this.BLOB_SIZE_LIMIT) {
      throw new Error(
        `File too large (${(this.meta.fileSize / 1e6).toFixed(0)}MB) for this browser. ` +
        `Use Chrome or Firefox for large file transfers.`
      );
    }

    if (this.writerMode === 'opfs') {
      await new Promise((resolve, reject) => {
        this.receiverWorker.postMessage({
          type: 'INIT',
          id: 'init',
          payload: {
            transferId: this.meta.transferId,
            totalChunks: this.meta.totalChunks
          }
        });
        this.receiverWorker.onmessage = ({ data }) => {
          if (data.type === 'INIT_READY') resolve();
        };
        this.receiverWorker.onerror = reject;
      });

      this.receiverWorker.onmessage = ({ data }) => {
        if (data.type === 'CHUNK_WRITTEN') {
          if (data.payload.done) {
            this._opfsWritten = true;
            this._maybeFinalize();
          }
        }
      };
    }

    if (this.writerMode === 'fsa') {
      // Requires a live user gesture — callers must pass userGesture=true
      // from a click handler (auto-accepted transfers fall back to OPFS).
      const handle = await window.showSaveFilePicker({
        suggestedName: this.meta.fileName
      });
      this.fsaWritable = await handle.createWritable();
    }
  }

  async receiveChunk(rawBuffer) {
    try {
      const { seq, total, chunkHash, payload } = parseChunkHeader(rawBuffer);

      // Duplicate delivery (NACK retransmit racing the slow original) —
      // already accounted for, do not double-count
      if (this.chunkHashMap.has(seq)) {
        return { valid: true, seq };
      }

      const { payload: { decrypted, valid, fullChunkHash } } = await this.cryptoPool.request(
        'DECRYPT_CHUNK',
        {
          rawKey: this.meta.rawKey,
          encryptedBuffer: payload,
          seq,
          expectedHash: chunkHash,
          decompress: this.meta.compress ?? false
        },
        [payload]
      );

      if (!valid) {
        return { valid: false, seq };
      }

      this.chunkHashMap.set(seq, fullChunkHash);
      this.receivedCount++;
      this.bytesReceived += decrypted.byteLength;
      this.onProgress(this.bytesReceived, this.meta.fileSize, this.receivedCount, total);

      if (this.writerMode === 'opfs') {
        this.receiverWorker.postMessage({
          type: 'WRITE_CHUNK',
          id: `chunk-${seq}`,
          payload: {
            decryptedBuffer: decrypted,
            seq,
            chunkSize: this.meta.chunkSize
          }
        }, [decrypted]);

      } else if (this.writerMode === 'fsa') {
        await this.fsaWritable.write({
          type: 'write',
          position: seq * this.meta.chunkSize,
          data: decrypted
        });
        this._maybeFinalize();

      } else {
        this.blobChunks.set(seq, decrypted);
        this._maybeFinalize();
      }

      return { valid: true, seq };

    } catch (err) {
      this.onError(err);
    }
  }

  // ── Control plane (chat path): stream end / integrity verification ──

  async handleStreamEnd(msg) {
    if (!msg || msg.transferId !== this.meta.transferId || this.done) return;
    if (msg.fileHash) this.expectedRoot = msg.fileHash;

    if (this.pullMode) {
      // Tier 3/4: the pull loop drives reception sequentially and handles
      // its own retries — just record the root and try to finish.
      this._maybeFinalize();
      return;
    }

    // WebRTC transfer channels and the chat channel are independent SCTP
    // streams — allow in-flight chunks to land before evaluating gaps.
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this._evaluateStreamEnd(), STREAM_SETTLE_MS);
  }

  _evaluateStreamEnd() {
    if (this.done || this.cancelled) return;
    const missing = this._computeMissing();

    if (this.receivedCount >= this.meta.totalChunks) {
      this._maybeFinalize();
      return;
    }

    if (missing.length && this.nackRounds < MAX_NACK_ROUNDS && this.messaging) {
      this.nackRounds++;
      activityLog.log('fallback', 'Requesting retransmit',
        `${missing.length} chunk(s) — round ${this.nackRounds}/${MAX_NACK_ROUNDS}`);
      Promise.resolve(this.messaging.send({
        type: 'file_nack',
        transferId: this.meta.transferId,
        seqs: missing
      })).catch(() => {});
      return;
    }

    if (missing.length) {
      this.onError(new Error(
        `Transfer incomplete: ${missing.length} chunk(s) unrecoverable after ${MAX_NACK_ROUNDS} retry rounds.`
      ));
      this._shutdown();
    }
  }

  _computeMissing() {
    const missing = [];
    for (let i = 0; i < this.meta.totalChunks; i++) {
      if (!this.chunkHashMap.has(i)) missing.push(i);
    }
    return missing;
  }

  async _maybeFinalize() {
    if (this.done || this.cancelled || this._finalizing) return;
    if (this.receivedCount < this.meta.totalChunks) return;
    if (this.writerMode === 'opfs' && !this._opfsWritten) return;
    this._finalizing = true;
    await this._finalize();
  }

  async _finalize() {
    // Wait briefly for the integrity root if it has not arrived yet
    const deadline = Date.now() + ROOT_WAIT_MS;
    while (!this.expectedRoot && Date.now() < deadline && !this.cancelled) {
      await sleep(200);
    }

    if (this.cancelled) return;

    if (!this.expectedRoot) {
      this.onError(new Error('Integrity hash was never received — transfer aborted.'));
      this._shutdown();
      return;
    }

    let localRoot;
    try {
      localRoot = await computeFileRoot(this.chunkHashMap, this.meta.totalChunks);
    } catch (e) {
      this.onError(new Error(`Integrity check failed: ${e.message}`));
      this._shutdown();
      return;
    }

    if (localRoot !== this.expectedRoot) {
      this.onError(new Error('Integrity verification failed — file does not match sender hash.'));
      this._shutdown();
      return;
    }

    activityLog.log('success', 'Integrity verified', `root ${localRoot.slice(0, 12)}...`);

    if (this.messaging) {
      Promise.resolve(this.messaging.send({
        type: 'file_complete',
        transferId: this.meta.transferId,
        root: localRoot
      })).catch(() => {});
    }

    try {
      if (this.writerMode === 'opfs') {
        await this._finalizeOPFS();
      } else if (this.writerMode === 'fsa') {
        await this._finalizeFSA();
      } else {
        this._finalizeBlob();
      }
    } catch (e) {
      this.onError(e);
      this._shutdown();
    }
  }

  async _finalizeOPFS() {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(this.meta.transferId);
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);

    const isMedia = this.isMedia();

    if (!isMedia) {
      this._triggerDownload(url, this.meta.fileName);

      // Non-media downloads are consumed immediately — safe to delete soon.
      setTimeout(async () => {
        this.receiverWorker.postMessage({
          type: 'CLEANUP',
          id: 'cleanup',
          payload: { transferId: this.meta.transferId }
        });
      }, 5000);
    }
    // Media previews keep the OPFS entry alive while displayed; the startup
    // sweeper collects stale files from previous sessions instead.

    this.onComplete(this.meta.fileHash, isMedia ? url : null);
    this._shutdown();
  }

  async _finalizeFSA() {
    await this.fsaWritable.close();
    this.onComplete(this.meta.fileHash, null);
    this._shutdown();
  }

  _finalizeBlob() {
    const sorted = [];
    for (let i = 0; i < this.meta.totalChunks; i++) {
      const part = this.blobChunks.get(i);
      if (part === undefined) {
        this.onError(new Error(`Assembly failed: chunk ${i} missing.`));
        return;
      }
      sorted.push(part);
    }
    const blob = new Blob(sorted, {
      type: this.meta.mimeType || 'application/octet-stream'
    });
    const url = URL.createObjectURL(blob);

    const isMedia = this.isMedia();
    if (!isMedia) {
      this._triggerDownload(url, this.meta.fileName);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    this.onComplete(this.meta.fileHash, isMedia ? url : null);
    this._shutdown();
  }

  isMedia() {
    return (
      this.meta.mimeType?.startsWith('image/') ||
      this.meta.mimeType?.startsWith('video/')
    );
  }

  cancel() {
    this.cancelled = true;
    this.done = true;
    clearTimeout(this._settleTimer);
    this.onError(new Error('Transfer cancelled.'));
    this._shutdown();
  }

  _shutdown() {
    this.done = true;
    clearTimeout(this._settleTimer);
    this.cryptoPool.terminate();
    this.receiverWorker.terminate();
    this.blobChunks.clear();
  }

  _triggerDownload(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async _detectWriterMode(userGesture) {
    // Keep the blob hack for small media files (<50MB) for instant, seamless inline previews.
    // For large videos, we fallback to SendAnywhere's style (OPFS/FSA) to prevent tab crashes.
    if (this.isMedia() && this.meta.fileSize < 50 * 1024 * 1024) {
      return 'blob';
    }

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    // The FSA save picker MUST run inside a live user gesture — without one
    // (e.g. auto-accepted media), fall through to gesture-less writers.
    if ('showSaveFilePicker' in window && !isMobile && userGesture) {
      return 'fsa';
    }
    if (navigator.storage && navigator.storage.getDirectory) {
      return 'opfs';
    }
    return 'blob';
  }
}
