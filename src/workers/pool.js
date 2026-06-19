export class WorkerPool {
  constructor(workerUrl, size) {
    this.size = Math.min(8, Math.max(2, size ?? navigator.hardwareConcurrency ?? 4));
    this.workers = [];
    this.pending = new Map();
    this.robin = 0;

    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      w.onmessage = ({ data }) => {
        const handler = this.pending.get(data.id);
        if (handler) {
          handler.resolve(data);
          this.pending.delete(data.id);
        }
      };
      w.onerror = (e) => {
        console.error('Worker error:', e);
        for (const [id, handler] of this.pending.entries()) {
          handler.reject(e);
        }
        this.pending.clear();
      };
      this.workers.push(w);
    }
  }

  request(type, payload, transferables = []) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, { resolve, reject });

      const worker = this.workers[this.robin % this.size];
      this.robin++;

      worker.postMessage({ type, id, payload }, transferables);
    });
  }

  terminate() {
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.pending.clear();
  }
}
