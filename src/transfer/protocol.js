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
