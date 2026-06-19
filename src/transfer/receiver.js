import { WorkerPool } from '../workers/pool';
import { parseChunkHeader } from './protocol';

export class Receiver {
  constructor(meta, onProgress, onComplete, onError) {
    this.meta = meta;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    
    this.cryptoPool = new WorkerPool(
      new URL('../workers/transfer.worker.js', import.meta.url)
    );
    
    this.receiverWorker = new Worker(
      new URL('../workers/receiver.worker.js', import.meta.url),
      { type: 'module' }
    );
    
    this.receivedCount = 0;
    this.writerMode = null;
    
    this.fsaChunks = new Map();
    this.fsaWritable = null;
    
    this.blobChunks = new Map();
    this.BLOB_SIZE_LIMIT = 500 * 1024 * 1024;
  }

  async init() {
    this.writerMode = await this._detectWriterMode();
    
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
          if (data.payload.done) this._finalizeOPFS();
        }
      };
    }
    
    if (this.writerMode === 'fsa') {
      const handle = await window.showSaveFilePicker({
        suggestedName: this.meta.fileName
      });
      this.fsaWritable = await handle.createWritable();
    }
  }

  async receiveChunk(rawBuffer) {
    try {
      const { seq, total, chunkHash, payload } = parseChunkHeader(rawBuffer);

      const { payload: { decrypted, valid } } = await this.cryptoPool.request(
        'DECRYPT_CHUNK',
        {
          rawKey: this.meta.rawKey,
          encryptedBuffer: payload,
          seq,
          expectedHash: chunkHash
        },
        [payload]
      );

      if (!valid) {
        return { valid: false, seq };
      }

      this.receivedCount++;
      const bytesReceived = this.receivedCount * (this.meta.fileSize / this.meta.totalChunks);
      this.onProgress(bytesReceived, this.meta.fileSize, this.receivedCount, this.meta.totalChunks);

      if (this.writerMode === 'opfs') {
        this.receiverWorker.postMessage({
          type: 'WRITE_CHUNK',
          id: `chunk-${seq}`,
          payload: {
            decryptedBuffer: decrypted,
            seq,
            chunkSize: 64 * 1024
          }
        }, [decrypted]);
        
      } else if (this.writerMode === 'fsa') {
        await this.fsaWritable.write({
          type: 'write',
          position: seq * 64 * 1024,
          data: decrypted
        });
        
        if (this.receivedCount === this.meta.totalChunks) {
          await this._finalizeFSA();
        }
        
      } else {
        this.blobChunks.set(seq, decrypted);
        
        if (this.receivedCount === this.meta.totalChunks) {
          this._finalizeBlob();
        }
      }

      return { valid: true, seq };
      
    } catch (err) {
      this.onError(err);
    }
  }

  async _finalizeOPFS() {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(this.meta.transferId);
    const file = await fileHandle.getFile();
    this._triggerDownload(URL.createObjectURL(file), this.meta.fileName);
    
    setTimeout(async () => {
      this.receiverWorker.postMessage({
        type: 'CLEANUP',
        id: 'cleanup',
        payload: { transferId: this.meta.transferId }
      });
    }, 5000);
    
    this.onComplete(this.meta.fileHash, null);
    this._shutdown();
  }

  async _finalizeFSA() {
    await this.fsaWritable.close();
    this.onComplete(this.meta.fileHash, null);
    this._shutdown();
  }

  _finalizeBlob() {
    const sorted = Array.from({ length: this.meta.totalChunks }, (_, i) =>
      this.blobChunks.get(i)
    );
    const blob = new Blob(sorted, {
      type: this.meta.mimeType || 'application/octet-stream'
    });
    const url = URL.createObjectURL(blob);
    
    const isMedia = this.meta.mimeType?.startsWith('image/') || this.meta.mimeType?.startsWith('video/');
    if (!isMedia) {
      this._triggerDownload(url, this.meta.fileName);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    
    this.onComplete(this.meta.fileHash, isMedia ? url : null);
    this._shutdown();
  }

  _shutdown() {
    this.cryptoPool.terminate();
    this.receiverWorker.terminate();
    this.fsaChunks.clear();
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

  async _detectWriterMode() {
    // Force blob for media so we can render inline
    if (this.meta.mimeType?.startsWith('image/') || this.meta.mimeType?.startsWith('video/')) {
      return 'blob';
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if ('showSaveFilePicker' in window && !isIOS) {
      return 'fsa';
    }
    if (navigator.storage && navigator.storage.getDirectory) {
      return 'opfs';
    }
    return 'blob';
  }
}
