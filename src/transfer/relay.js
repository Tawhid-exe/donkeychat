import { activityLog } from '../utils/activityLog';
import { isSupabaseConfigured, getSupabaseClient } from '../core/signaling';

// FIX #12: HTTP Relay — proper implementation with real fetch calls

const RELAY_URL = import.meta.env.VITE_RELAY_URL || '';
const hasRelay = RELAY_URL && !RELAY_URL.includes('placeholder');

export class HTTPRelaySender {
  constructor(relayUrl, remotePeerId, localPeerId) {
    this.relayUrl = relayUrl || RELAY_URL;
    this.remotePeerId = remotePeerId;
    this.localPeerId = localPeerId;
  }

  async send(file, onProgress, onComplete, onError) {
    if (!hasRelay) {
      activityLog.log('error', 'HTTP Relay unavailable',
        'No relay server configured. Set VITE_RELAY_URL in .env.local');
      onError(new Error(
        'HTTP Relay is not configured. You need to deploy a Bun.js relay server ' +
        'and set VITE_RELAY_URL in your .env.local file.'
      ));
      return;
    }

    const transferId = crypto.randomUUID();
    const CHUNK_SIZE = 64 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    try {
      activityLog.log('info', 'HTTP Relay transfer', `${file.name} via ${this.relayUrl}`);

      // Register transfer with relay server
      const initResp = await fetch(`${this.relayUrl}/transfer/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId,
          from: this.localPeerId,
          to: this.remotePeerId,
          fileName: file.name,
          fileSize: file.size,
          totalChunks
        })
      });

      if (!initResp.ok) throw new Error(`Relay server error: ${initResp.status}`);

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const resp = await fetch(`${this.relayUrl}/transfer/${transferId}/chunk/${i}`, {
          method: 'PUT',
          body: chunk
        });

        if (!resp.ok) throw new Error(`Chunk upload failed: ${resp.status}`);

        const bytesSent = Math.min((i + 1) * CHUNK_SIZE, file.size);
        onProgress(bytesSent, file.size, i + 1, totalChunks);
      }

      onComplete(transferId, totalChunks);
      activityLog.log('success', 'HTTP Relay complete', file.name);
    } catch (e) {
      activityLog.log('error', 'HTTP Relay failed', e.message);
      onError(e);
    }
  }
}

// Tier 4: Store and Forward (Async Supabase Storage)
export async function uploadChunkToStorage(transferId, seq, encryptedChunk) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error('Supabase not configured — cannot use async transfer');
  }

  const { error } = await supabase.storage
    .from('blaze-transfers')
    .upload(
      `${transferId}/${seq.toString().padStart(6, '0')}`,
      encryptedChunk,
      { contentType: 'application/octet-stream', upsert: false }
    );
  if (error) throw error;
}

export async function downloadChunkFromStorage(transferId, seq) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error('Supabase not configured — cannot download chunks');
  }

  const { data, error } = await supabase.storage
    .from('blaze-transfers')
    .download(`${transferId}/${seq.toString().padStart(6, '0')}`);
  if (error) throw error;
  return data.arrayBuffer();
}

export async function cleanupStorage(transferId, totalChunks) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const paths = Array.from({ length: totalChunks }, (_, i) =>
    `${transferId}/${i.toString().padStart(6, '0')}`
  );
  await supabase.storage.from('blaze-transfers').remove(paths);
}
