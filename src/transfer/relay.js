import { getSupabaseClient } from '../core/signaling';

// Single choke point for Tier 3/4 chunk IO.
//
// Store selection:
//   - intent 'http'  → always the self-hosted mini relay (VITE_RELAY_URL,
//     or the HTTP origin derived from VITE_RELAY_WS_URL).
//   - intent 'async' → Supabase Storage when available, else the mini
//     relay. This is what keeps Tier 4 working when a free-tier Supabase
//     project gets paused.

const HTTP_RELAY_URL = import.meta.env.VITE_RELAY_URL || '';
const WS_RELAY_URL = import.meta.env.VITE_RELAY_WS_URL || '';

function usable(url) {
  return url && !url.includes('placeholder') ? url : '';
}

function httpBaseFromWsUrl(wsUrl) {
  try {
    const u = new URL(wsUrl);
    return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
  } catch {
    return '';
  }
}

export function resolveChunkStore(intent = 'async') {
  if (intent === 'http') {
    const base = usable(HTTP_RELAY_URL) ||
      httpBaseFromWsUrl(usable(WS_RELAY_URL) || '');
    return base ? { mode: 'http', base } : { mode: 'none', base: '' };
  }

  if (getSupabaseClient()) return { mode: 'supabase', base: '' };

  const base = usable(HTTP_RELAY_URL) ||
    httpBaseFromWsUrl(usable(WS_RELAY_URL) || '');
  return base ? { mode: 'http', base } : { mode: 'none', base: '' };
}

export function initChunkTransfer(transferId, meta, intent = 'async') {
  const store = resolveChunkStore(intent);
  if (store.mode !== 'http') return Promise.resolve();
  return fetch(`${store.base}/transfer/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  }).then((resp) => {
    if (!resp.ok) throw new Error(`Chunk store init failed: ${resp.status}`);
  });
}

export async function uploadChunkToStorage(transferId, seq, encryptedChunk, intent = 'async') {
  const store = resolveChunkStore(intent);

  if (store.mode === 'supabase') {
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage
      .from('blaze-transfers')
      .upload(
        `${transferId}/${seq.toString().padStart(6, '0')}`,
        encryptedChunk,
        { contentType: 'application/octet-stream', upsert: false }
      );
    if (error) throw error;
    return;
  }

  if (store.mode === 'http') {
    const resp = await fetch(`${store.base}/transfer/${transferId}/chunk/${seq}`, {
      method: 'PUT',
      body: encryptedChunk
    });
    if (!resp.ok) throw new Error(`Chunk store upload failed: ${resp.status}`);
    return;
  }

  throw new Error('No chunk store available — configure Supabase or a backup relay server');
}

export async function downloadChunkFromStorage(transferId, seq, intent = 'async') {
  const store = resolveChunkStore(intent);

  if (store.mode === 'supabase') {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from('blaze-transfers')
      .download(`${transferId}/${seq.toString().padStart(6, '0')}`);
    if (error) throw error;
    return data.arrayBuffer();
  }

  if (store.mode === 'http') {
    const resp = await fetch(`${store.base}/transfer/${transferId}/chunk/${seq}`);
    if (!resp.ok) {
      const err = new Error(`Chunk not available (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return resp.arrayBuffer();
  }

  throw new Error('No chunk store available — configure Supabase or a backup relay server');
}

export async function cleanupStorage(transferId, totalChunks, intent = 'async') {
  const store = resolveChunkStore(intent);

  if (store.mode === 'supabase') {
    const supabase = getSupabaseClient();
    const paths = Array.from({ length: totalChunks }, (_, i) =>
      `${transferId}/${i.toString().padStart(6, '0')}`
    );
    await supabase.storage.from('blaze-transfers').remove(paths);
    return;
  }

  if (store.mode === 'http') {
    try {
      await fetch(`${store.base}/transfer/${transferId}`, { method: 'DELETE' });
    } catch {
      // Server TTL sweep will collect it — best effort only
    }
  }
}
