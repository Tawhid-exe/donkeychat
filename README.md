# DonkeyChat (Blaze Architecture)

DonkeyChat is an ephemeral, P2P file-sharing and chat application designed to function without user accounts, utilizing browser-native WebCrypto, WebRTC, and tiered network failovers.

## 🚀 Features & Capabilities

- **Zero-Login Identity:** Your identity is an ECDH (P-256) keypair generated purely in your browser's `localStorage`. No accounts, no emails, no server tracking.
- **Hardware-Accelerated Security:** Every file is encrypted using AES-GCM 256-bit with hardware acceleration via WebCrypto, processing chunks in parallel across a dedicated Worker Pool.
- **P2P Transfer Speeds:** Up to 1 Gbps on local networks via 4 parallel WebRTC DataChannels.
- **Memory-Safe Architecture:** Sender uses `File.stream()` for zero-accumulation hashing. Receiver uses `FileSystemSyncAccessHandle` (OPFS) or `File System Access API` to stream file parts directly to disk, capable of handling 50GB+ files without crashing the browser.

### 🌐 Network Tiers & Failovers

DonkeyChat intelligently routes your connection based on your network environment, seamlessly upgrading or falling back without interrupting your chat:

1. **Tier 0: LAN Direct (WebRTC)**
   - Connects devices on the same WiFi router via public-IP discovery-room hashing (devices behind the same router share a room instantly).
   - Detects "AP Isolation" (common on university/cafe networks) and fails-fast within 3 seconds.
2. **Tier 1: WAN P2P (WebRTC)**
   - Connects devices across the internet using STUN.
   - Join via a 6-character room code, share URL, or QR Code.
3. **Tier 2: TURN Relay (WebRTC)**
   - Bypasses strict firewalls and symmetric NATs using a TURN server.
4. **Tier 3: HTTP Relay (Server)**
   - Fallback proxy stream when WebRTC is completely blocked (requires custom deployment — set `VITE_RELAY_URL`).
5. **Tier 4: Store & Forward (Supabase Async)**
   - Asynchronous transfer for unreachable peers via Supabase Storage.
   - **Auto-promoted:** when all WebRTC candidates fail (`ice_timeout` / connection failure), the engine automatically switches new transfers to Tier 4 while chat continues over the encrypted relay path.

### 🛠️ Developer Tools & UI

- **Activity Log Dropdown:** Located in the top left, this real-time event monitor displays method failovers (e.g., LAN ICE failed → WAN/TURN), connection state changes, and internal network events.
- **Online User Meter:** Tracks exactly how many peers are visible on the network discovery layer.
- **QR Code Connectivity:** Instantly share and scan room codes to bridge mobile and desktop devices without typing.
- **Direct DOM Updates for Progress:** Over 200 chunks per second are transferred, but UI progress is throttled to 10 FPS and written directly to the DOM, bypassing React reconciliations to preserve CPU performance.

### 🔁 Transfer Integrity (NACK + Merkle Verification)

Every transfer is self-healing and end-to-end verifiable:

1. Each chunk's plaintext is hashed with full SHA-256; the receiver recomputes these hashes after authenticated decryption.
2. The sender derives a whole-file root (`SHA-256` over all chunk hashes) once streaming completes and sends it via the control channel.
3. Missing or corrupted chunks are requested automatically by the receiver (**NACK**, up to 5 rounds) — no silent holes, ever.
4. The receiver assembles the file only after its own computed root matches the sender's root, then acknowledges completion. The sender reports success only on that verified ack.
5. Tier 3/4 pulls run sequentially with a bounded retry budget and abort honestly instead of polling forever.

### 🛡️ End-to-End Encryption

- **Ephemeral ECDH (P-256)** keypairs are exchanged inside the WebRTC offer/answer payloads; both sides derive an AES-GCM 256 session key via HKDF-SHA256 (bound to the room ID).
- **All chat messages** — text, file metadata, and per-file encryption keys — are sealed with this session key before they touch any transport. The WebRTC data channel *and* the Supabase relay fallback carry ciphertext only.
- Session keys are non-extractable and never persisted; a new connection means a new key (forward secrecy between sessions).
- Trust model: peers authenticate each other through the signaling channel the same way SDP/DTLS fingerprints are exchanged today. A malicious signaling operator could theoretically MITM the handshake — out-of-band fingerprint verification (QR) is future work.

## 📦 Deployment & Configuration

DonkeyChat is designed as a plug-and-play frontend for deployment on **Vercel**, **Netlify**, or **Cloudflare Pages**.

### Environment Variables (`.env.local`)

To enable the signaling and fallback layers, you must provide the following:

```env
# Required: Supabase is used strictly for signaling (SDP/ICE exchange) and presence.
# Create a free project at supabase.com
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Optional: TURN server credentials for Tier 2 strict NAT traversal (e.g., metered.ca)
VITE_TURN_URL=turn:global.turn.twilio.com:3478?transport=udp
VITE_TURN_USER=your_username
VITE_TURN_PASS=your_password

# Optional: Backup relay server (see "Backup Relay Server" below).
# Powers automatic failover when Supabase is unreachable, plus Tier 3/4 chunk storage.
VITE_RELAY_WS_URL=wss://donkeychat-relay.onrender.com/ws

# Optional: shared secret matching RELAY_TOKEN on the relay server
VITE_RELAY_TOKEN=
```

### Backup Relay Server

Free-tier Supabase projects pause after inactivity — which would normally kill signaling, presence, relay chat, **and** async transfers. DonkeyChat ships a self-hosted mini relay (`/server`, Node 20 + `ws`) that the frontend automatically fails over to when Supabase doesn't respond:

1. Deploy it in one click from this repo using the included `render.yaml` blueprint (Render → New → Blueprint). Or run it anywhere: `cd server && npm install && npm start`.
2. Verify a deployment with `cd server && node smoke.test.mjs` (against `http://localhost:8787`, or edit the `BASE` constant for your deployed URL).
3. Set `VITE_RELAY_WS_URL` to `wss://<your-service>.onrender.com/ws`.
3. Optional hardening via Render env vars: `RELAY_TOKEN` (shared secret required by every route) and `ORIGIN` (locks CORS to your frontend).

Behavior:
- On startup, each channel probes Supabase for ~6 seconds; if it never confirms, all signaling/presence/chat transparently switch to the relay's WebSocket endpoint. The header badge shows **Backup Relay Online**.
- Tier 3/4 chunk transfers automatically use the relay's in-memory store whenever Supabase Storage isn't available.
- All payloads are E2E ciphertext — the relay can never read messages, keys, or file chunks.

Limitations of the free tier: the service sleeps after ~15 min idle (~40s cold start; keep it warm with a `/healthz` ping), and the chunk store is memory-only, so offline delivery requires a live instance. For always-on durability, upgrade the plan or move chunk storage to persistent infrastructure.

### Build Steps

1. Install dependencies: `npm install`
2. Run local development server: `npm run dev`
3. Build for production: `npm run build`

## 🔒 Security Model

- **P2P Eavesdrop Prevention:** WebRTC DTLS is mandatory by spec, and all application messages carry an additional E2E AES-GCM layer (see End-to-End Encryption above).
- **Relay Eavesdrop Prevention:** All chunks are AES-GCM 256-bit encrypted before leaving the browser. The signaling server (Supabase), relay servers, and storage buckets only ever see ciphertext — plaintext payloads and keys never leave the two endpoints.
- **Chunk Corruption:** Full SHA-256 integrity check per chunk plus a whole-file Merkle-style root verified before assembly; missing or corrupted chunks are retransmitted via NACK.
- **Replay Attack:** Unique 96-bit random IV per chunk encryption.
- **CGNAT Collision:** Devices sharing a public IP join the same discovery room; transfers still require an explicit peer accept.
