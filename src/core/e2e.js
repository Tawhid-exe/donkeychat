// E2E session encryption: ephemeral ECDH P-256 + HKDF-SHA256 -> AES-GCM 256.
// Ephemeral pubkeys are exchanged inside the existing WebRTC offer/answer
// signaling payloads, so no extra round-trip is needed. The derived session
// key never leaves the browser and is non-extractable.

const E2E_INFO = 'blaze-e2e-v1';

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function generateEphemeralPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

// Minimal JWK (public components only) safe to embed in signaling payloads
export async function exportEphemeralPub(publicKey) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export async function deriveSessionKey(privateKey, peerPublicJwk, roomId) {
  const peerPub = await crypto.subtle.importKey(
    'jwk', peerPublicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true, []
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPub },
    privateKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey(
    'raw', sharedBits, 'HKDF', false, ['deriveKey']
  );
  const enc = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(roomId),
      info: enc.encode(E2E_INFO)
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { e2e: true, iv: b64encode(iv), data: b64encode(ciphertext) };
}

export async function decryptJSON(key, envelope) {
  const iv = new Uint8Array(b64decode(envelope.iv));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    b64decode(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
