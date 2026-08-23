import WebSocket from 'ws';

// Usage:
//   node smoke.test.mjs                          → http://localhost:8787, no token
//   SMOKE_BASE=https://x.onrender.com SMOKE_TOKEN=secret node smoke.test.mjs
const BASE = process.env.SMOKE_BASE || 'http://localhost:8787';
const TOKEN = process.env.SMOKE_TOKEN || '';
const WS_BASE = BASE.replace(/^http/, 'ws');
const authHeaders = (extra = {}) => (TOKEN ? { 'X-Relay-Token': TOKEN, ...extra } : extra);
const wsUrl = `${WS_BASE}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`;

let failures = 0;
function assert(cond, name) {
  if (cond) { console.log('PASS', name); } else { failures++; console.log('FAIL', name); }
}

function waitFor(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeoutMs);
    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── REST chunk store (unique id per run — safe against live instances) ──
const RUN_ID = `smoke-${Date.now().toString(36)}`;
const health = await fetch(`${BASE}/healthz`);
assert(health.ok, 'healthz');
console.log('      server:', JSON.stringify(await health.json()));

const init = await fetch(`${BASE}/transfer/init`, {
  method: 'POST',
  headers: authHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify({ transferId: RUN_ID, totalChunks: 2 })
});
assert(init.ok, 'transfer init');

const payload = Buffer.from('smoke-chunk-plaintext-0123456789abcdef');
const put = await fetch(`${BASE}/transfer/${RUN_ID}/chunk/0`, { method: 'PUT', headers: authHeaders(), body: payload });
assert(put.ok, 'chunk PUT');

const get = await fetch(`${BASE}/transfer/${RUN_ID}/chunk/0`, { headers: authHeaders() });
const got = Buffer.from(await get.arrayBuffer());
assert(get.ok && got.equals(payload), 'chunk GET roundtrip matches bytes');

const missing = await fetch(`${BASE}/transfer/${RUN_ID}/chunk/5`, { headers: authHeaders() });
assert(missing.status === 404, 'missing chunk returns 404');

// ── WebSocket signaling ──
const ws1 = new WebSocket(wsUrl);
await new Promise((r) => ws1.once('open', r));
ws1.send(JSON.stringify({ type: 'join', room: 'smoke-room', peerId: 'peer-A', presence: { displayName: 'Alice', os: 'win' } }));
const ready1 = await waitFor(ws1, 'ready');
assert(!!ready1, 'A receives ready');

const ws2 = new WebSocket(wsUrl);
await new Promise((r) => ws2.once('open', r));
const peersPromise1 = waitFor(ws1, 'peers');
ws2.send(JSON.stringify({ type: 'join', room: 'smoke-room', peerId: 'peer-B', presence: { displayName: 'Bob', os: 'linux' } }));
await waitFor(ws2, 'ready');
const peersMsg = await peersPromise1;
assert(peersMsg.peers.length === 1 && peersMsg.peers[0].id === 'peer-B' && peersMsg.peers[0].displayName === 'Bob',
  'A sees B in peers list (with presence)');

// Targeted signal routing A -> B
const sigPromiseB = waitFor(ws2, 'signal');
ws1.send(JSON.stringify({ type: 'signal', to: 'peer-B', payload: { type: 'offer', from: 'peer-A', sdp: 'x' } }));
const sigB = await sigPromiseB;
assert(sigB.payload?.type === 'offer' && sigB.payload?.from === 'peer-A', 'targeted signal routed to B with envelope intact');

// Broadcast chat reaches other members, not the sender
const chatPromiseB = waitFor(ws2, 'relay_chat');
ws1.send(JSON.stringify({ type: 'chat', payload: { e2e: true, iv: 'iv', data: 'ct', from: 'peer-A' } }));
const chatB = await chatPromiseB;
assert(chatB.payload?.data === 'ct', 'broadcast relay_chat delivered to B');
let echoedToSender = false;
const probeHandler = (raw) => { if (raw.toString().includes('relay_chat')) echoedToSender = true; };
ws1.on('message', probeHandler);
await new Promise((r) => setTimeout(r, 400));
ws1.off('message', probeHandler);
assert(!echoedToSender, 'sender does NOT receive own broadcast');

// Presence update propagates
const peersPromise2 = waitFor(ws2, 'peers');
ws1.send(JSON.stringify({ type: 'presence_update', presence: { displayName: 'Alice2', os: 'win' } }));
const pm2 = await peersPromise2;
assert(pm2.peers[0]?.displayName === 'Alice2', 'presence_update rebroadcast');

ws1.close();
ws2.close();

// Cleanup endpoint
const del = await fetch(`${BASE}/transfer/${RUN_ID}`, { method: 'DELETE', headers: authHeaders() });
assert(del.ok, 'DELETE transfer cleanup');
const gone = await fetch(`${BASE}/transfer/${RUN_ID}/chunk/0`, { headers: authHeaders() });
assert(gone.status === 404, 'chunks gone after cleanup');

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
