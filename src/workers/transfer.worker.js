const CHUNK_SIZE = 64 * 1024;

async function generateFileKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function exportKey(key) {
  return crypto.subtle.exportKey('raw', key);
}

async function importKey(rawKey) {
  return crypto.subtle.importKey(
    'raw', rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptChunk(key, chunkBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    chunkBuffer
  );
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), 12);
  return result.buffer;
}

async function decryptChunk(key, encryptedBuffer) {
  const arr = new Uint8Array(encryptedBuffer);
  const iv = arr.slice(0, 12);
  const payload = arr.slice(12);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    payload
  );
}

async function hashChunk(chunkBuffer) {
  const h = await crypto.subtle.digest('SHA-256', chunkBuffer);
  return Array.from(new Uint8Array(h))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('').slice(0, 16);
}

async function compressChunk(buffer) {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(buffer);
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(c => { result.set(c, offset); offset += c.length; });
  return result.buffer;
}

async function decompressChunk(buffer) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  writer.write(buffer);
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(c => { result.set(c, offset); offset += c.length; });
  return result.buffer;
}

self.onmessage = async ({ data }) => {
  const { type, id, payload } = data;

  // FIX #4: New message type for key generation only (no file buffer needed)
  if (type === 'GENERATE_KEY') {
    const key = await generateFileKey();
    const rawKey = await exportKey(key);

    self.postMessage({
      type: 'KEY_READY',
      id,
      payload: {
        rawKey: Array.from(new Uint8Array(rawKey))
      }
    });
  }

  // Legacy: PREPARE_SEND (kept for backward compatibility)
  if (type === 'PREPARE_SEND') {
    const { fileBuffer, fileName, fileSize, mimeType } = payload;

    const key = await generateFileKey();
    const rawKey = await exportKey(key);

    // Hash the provided buffer
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const fileHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    self.postMessage({
      type: 'SEND_READY',
      id,
      payload: {
        rawKey: Array.from(new Uint8Array(rawKey)),
        fileHash,
        totalChunks,
        chunkSize: CHUNK_SIZE,
        fileName,
        fileSize,
        mimeType
      }
    });
  }

  if (type === 'PROCESS_CHUNK') {
    const { rawKey, chunkBuffer, seq, compress, mimeType } = payload;

    const key = await importKey(new Uint8Array(rawKey).buffer);

    let processedBuffer = chunkBuffer;
    if (compress && isCompressible(mimeType)) {
      processedBuffer = await compressChunk(chunkBuffer);
    }

    const encrypted = await encryptChunk(key, processedBuffer);
    const chunkHash = await hashChunk(chunkBuffer);

    self.postMessage({
      type: 'CHUNK_READY',
      id,
      payload: { encrypted, seq, chunkHash }
    }, [encrypted]);
  }

  if (type === 'DECRYPT_CHUNK') {
    const { rawKey, encryptedBuffer, seq, expectedHash, decompress } = payload;

    const key = await importKey(new Uint8Array(rawKey).buffer);
    let decrypted = await decryptChunk(key, encryptedBuffer);

    // Decompress if the sender compressed this chunk
    if (decompress) {
      decrypted = await decompressChunk(decrypted);
    }

    const actualHash = await hashChunk(decrypted);
    const valid = actualHash === expectedHash;

    self.postMessage({
      type: 'CHUNK_DECRYPTED',
      id,
      payload: { decrypted, seq, valid }
    }, [decrypted]);
  }
};

function isCompressible(mimeType) {
  if (!mimeType) return false;
  return (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('javascript') ||
    mimeType.includes('svg')
  );
}
