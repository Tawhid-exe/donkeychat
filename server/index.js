import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const ORIGIN = process.env.ORIGIN || '*';

const CHUNK_TTL_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const MAX_CHUNK_BYTES = 128 * 1024;
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const MAX_TRANSFERS = 100;

// roomId -> Map<peerId, { ws, presence }>
const rooms = new Map();
// transferId -> { totalChunks, bytes, chunks: Map<seq, Buffer>, createdAt }
const transfers = new Map();

const wss = new WebSocketServer({ noServer: true });

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Relay-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isAuthorized(req, url) {
  if (!RELAY_TOKEN) return true;
  return (
    req.headers['x-relay-token'] === RELAY_TOKEN ||
    url.searchParams.get('token') === RELAY_TOKEN
  );
}

function peersSnapshot(roomState, excludePeerId) {
  const out = [];
  for (const [id, entry] of roomState) {
    if (id !== excludePeerId) out.push({ id, ...entry.presence });
  }
  return out;
}

function broadcastPeers(roomState) {
  const frames = [];
  for (const [peerId, entry] of roomState) {
    if (entry.ws.readyState !== entry.ws.OPEN) continue;
    frames.push([entry.ws, JSON.stringify({
      type: 'peers',
      peers: peersSnapshot(roomState, peerId)
    })]);
  }
  for (const [ws, frame] of frames) ws.send(frame);
}

function detachFromRoom(roomId, peerId, ws) {
  const roomState = rooms.get(roomId);
  if (!roomState) return;
  const entry = roomState.get(peerId);
  if (!entry || entry.ws !== ws) return;
  roomState.delete(peerId);
  if (roomState.size === 0) {
    rooms.delete(roomId);
  } else {
    broadcastPeers(roomState);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let roomId = null;
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join' && msg.room && msg.peerId) {
      if (roomId) detachFromRoom(roomId, peerId, ws);
      roomId = String(msg.room).slice(0, 200);
      peerId = String(msg.peerId).slice(0, 120);

      let roomState = rooms.get(roomId);
      if (!roomState) {
        roomState = new Map();
        rooms.set(roomId, roomState);
      }

      // Reconnect of the same peer id — drop the stale socket
      const prev = roomState.get(peerId);
      if (prev && prev.ws !== ws) {
        try { prev.ws.close(); } catch { /* already gone */ }
      }

      roomState.set(peerId, { ws, presence: msg.presence || {} });
      ws.send(JSON.stringify({ type: 'ready', room: roomId }));
      broadcastPeers(roomState);
      return;
    }

    if (!roomId || !peerId) return;
    const roomState = rooms.get(roomId);
    if (!roomState || !roomState.has(peerId)) return;

    if (msg.type === 'presence_update' && msg.presence) {
      const entry = roomState.get(peerId);
      entry.presence = msg.presence;
      broadcastPeers(roomState);
      return;
    }

    // Signal/chat payloads are opaque E2E envelopes — routed verbatim
    if (msg.type === 'signal' || msg.type === 'chat') {
      const frame = JSON.stringify({
        type: msg.type === 'chat' ? 'relay_chat' : 'signal',
        payload: msg.payload
      });
      const targetId = msg.to || msg.payload?.to;
      if (targetId) {
        const target = roomState.get(targetId);
        if (target && target.ws.readyState === target.ws.OPEN) {
          target.ws.send(frame);
        }
      } else {
        for (const [id, entry] of roomState) {
          if (id !== peerId && entry.ws.readyState === entry.ws.OPEN) {
            entry.ws.send(frame);
          }
        }
      }
    }
  });

  ws.on('close', () => {
    if (roomId && peerId) detachFromRoom(roomId, peerId, ws);
  });

  ws.on('error', () => {});
});

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function evictOldestTransferIfNeeded() {
  while (transfers.size >= MAX_TRANSFERS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, t] of transfers) {
      if (t.createdAt < oldestTime) {
        oldestTime = t.createdAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    transfers.delete(oldestKey);
  }
}

function sweepExpiredTransfers() {
  const now = Date.now();
  for (const [key, t] of transfers) {
    if (now - t.createdAt > CHUNK_TTL_MS) transfers.delete(key);
  }
}

setInterval(() => {
  sweepExpiredTransfers();

  const dead = [];
  for (const roomState of rooms.values()) {
    for (const [pid, entry] of roomState) {
      if (entry.ws.isAlive === false) {
        dead.push([roomState, pid, entry]);
      } else {
        entry.ws.isAlive = false;
        entry.ws.ping();
      }
    }
  }
  for (const [roomState, pid, entry] of dead) {
    roomState.delete(pid);
    try { entry.ws.terminate(); } catch { /* already gone */ }
  }
  for (const [roomId, roomState] of [...rooms]) {
    if (roomState.size === 0) rooms.delete(roomId);
    else if (dead.length) broadcastPeers(roomState);
  }
}, HEARTBEAT_INTERVAL_MS);

const server = createServer(async (req, res) => {
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    json(res, 400, { error: 'bad request' });
    return;
  }

  if (url.pathname === '/healthz') {
    json(res, 200, {
      ok: true,
      uptime: Math.floor(process.uptime()),
      rooms: rooms.size,
      pendingTransfers: transfers.size
    });
    return;
  }

  if (!isAuthorized(req, url)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/transfer/init') {
    let meta;
    try {
      meta = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
    } catch {
      json(res, 400, { error: 'invalid json' });
      return;
    }
    if (!meta.transferId || !Number.isInteger(meta.totalChunks) || meta.totalChunks < 1) {
      json(res, 400, { error: 'transferId and totalChunks required' });
      return;
    }
    evictOldestTransferIfNeeded();
    transfers.set(meta.transferId, {
      totalChunks: meta.totalChunks,
      bytes: 0,
      chunks: new Map(),
      createdAt: Date.now()
    });
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const whole = url.pathname.match(/^\/transfer\/([\w-]{6,120})$/);
    if (whole) {
      transfers.delete(whole[1]);
      json(res, 200, { ok: true });
      return;
    }
  }

  const chunkMatch = url.pathname.match(/^\/transfer\/([\w-]{6,120})\/chunk\/(\d{1,7})$/);
  if (chunkMatch) {
    const [, transferId, seqStr] = chunkMatch;
    const seq = parseInt(seqStr, 10);

    if (req.method === 'GET') {
      const t = transfers.get(transferId);
      const chunk = t && t.chunks.get(seq);
      if (!chunk) {
        json(res, 404, { error: 'chunk not available yet' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': chunk.length,
        'Cache-Control': 'no-store'
      });
      res.end(chunk);
      return;
    }

    if (req.method === 'PUT') {
      const t = transfers.get(transferId);
      if (!t) {
        json(res, 404, { error: 'unknown transfer — call /transfer/init first' });
        return;
      }
      let buf;
      try {
        buf = await readBody(req, MAX_CHUNK_BYTES);
      } catch {
        json(res, 413, { error: 'chunk too large' });
        return;
      }
      if (!t.chunks.has(seq)) {
        t.bytes += buf.length;
        if (t.bytes > MAX_TRANSFER_BYTES) {
          transfers.delete(transferId);
          json(res, 413, { error: 'transfer exceeds size cap' });
          return;
        }
      }
      t.chunks.set(seq, buf);
      json(res, 200, { ok: true });
      return;
    }
  }

  json(res, 404, { error: 'not found' });
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws' || !isAuthorized(req, url)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, () => {
  console.log(`[donkeychat-relay] listening on :${PORT} (token auth: ${RELAY_TOKEN ? 'on' : 'off'})`);
});
