let accessHandle = null;
let expectedTotal = null;
let receivedCount = 0;

self.onmessage = async ({ data }) => {
  const { type, id, payload } = data;

  if (type === 'INIT') {
    const { transferId, totalChunks } = payload;
    expectedTotal = totalChunks;
    
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(transferId, { create: true });
    
    accessHandle = await fileHandle.createSyncAccessHandle();
    
    self.postMessage({ type: 'INIT_READY', id });
  }

  if (type === 'WRITE_CHUNK') {
    const { decryptedBuffer, seq, chunkSize } = payload;
    const offset = seq * chunkSize;
    
    accessHandle.write(new Uint8Array(decryptedBuffer), { at: offset });
    receivedCount++;
    
    const done = receivedCount === expectedTotal;
    if (done) {
      accessHandle.flush();
      accessHandle.close();
      accessHandle = null;
    }
    
    self.postMessage({ type: 'CHUNK_WRITTEN', id, payload: { seq, done } }, [decryptedBuffer]);
  }

  if (type === 'CLEANUP') {
    const { transferId } = payload;
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(transferId);
    } catch {}
    self.postMessage({ type: 'CLEANUP_DONE', id });
  }
};
