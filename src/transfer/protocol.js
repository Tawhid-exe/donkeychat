const HEADER_SIZE = 60;
const HASH_SIZE = 16;
const ID_SIZE = 36;

export function buildChunkHeader(seq, total, chunkHash, transferId, payloadBuffer) {
  const header = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(header);
  view.setUint32(0, seq, false);
  view.setUint32(4, total, false);
  
  const hashBytes = new TextEncoder().encode(chunkHash.slice(0, HASH_SIZE).padEnd(HASH_SIZE, ' '));
  new Uint8Array(header).set(hashBytes, 8);
  
  const idBytes = new TextEncoder().encode(transferId.slice(0, ID_SIZE).padEnd(ID_SIZE, ' '));
  new Uint8Array(header).set(idBytes, 24);
  
  const combined = new Uint8Array(HEADER_SIZE + payloadBuffer.byteLength);
  combined.set(new Uint8Array(header), 0);
  combined.set(new Uint8Array(payloadBuffer), HEADER_SIZE);
  return combined.buffer;
}

export function parseChunkHeader(buffer) {
  const view = new DataView(buffer);
  const seq = view.getUint32(0, false);
  const total = view.getUint32(4, false);
  const hashBytes = new Uint8Array(buffer, 8, HASH_SIZE);
  const chunkHash = new TextDecoder().decode(hashBytes).trim();
  const idBytes = new Uint8Array(buffer, 24, ID_SIZE);
  const transferId = new TextDecoder().decode(idBytes).trim();
  const payload = buffer.slice(HEADER_SIZE);
  return { seq, total, chunkHash, transferId, payload };
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Whole-file integrity root: SHA-256 over the concatenation of every chunk's
 * full plaintext hash, in sequence order. Both sides compute this locally and
 * compare, giving end-to-end tamper/corruption detection without ever
 * transmitting the file itself twice.
 *
 * @param {Map<number,string>|string[]} chunkHashes - seq -> 64-char hex hash
 * @param {number} totalChunks
 */
export async function computeFileRoot(chunkHashes, totalChunks) {
  const encoder = new TextEncoder();
  const parts = [];
  let totalLen = 0;
  for (let i = 0; i < totalChunks; i++) {
    const h = chunkHashes.get ? chunkHashes.get(i) : chunkHashes[i];
    if (!h) throw new Error(`Missing hash for chunk ${i}`);
    parts.push(encoder.encode(h));
    totalLen += h.length;
  }
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', combined);
  return bytesToHex(digest);
}

/** Full-length SHA-256 hex digest of an ArrayBuffer */
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(digest);
}
