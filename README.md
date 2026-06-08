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
   - Connects devices on the same WiFi router via deterministic ICE subnet hashing.
   - Detects "AP Isolation" (common on university/cafe networks) and fails-fast within 3 seconds.
2. **Tier 1: WAN P2P (WebRTC)**
   - Connects devices across the internet using STUN.
   - Join via a 6-character room code, share URL, or QR Code.
3. **Tier 2: TURN Relay (WebRTC)**
   - Bypasses strict firewalls and symmetric NATs using a TURN server.
4. **Tier 3: HTTP Relay (Server)**
   - Fallback proxy stream when WebRTC is completely blocked (requires custom deployment).
5. **Tier 4: Store & Forward (Supabase Async)**
   - Asynchronous transfer for offline peers via Supabase Storage.

### 🛠️ Developer Tools & UI

- **Activity Log Dropdown:** Located in the top left, this real-time event monitor displays method failovers (e.g., LAN ICE failed → WAN/TURN), connection state changes, and internal network events.
- **Online User Meter:** Tracks exactly how many peers are visible on the network discovery layer.
- **QR Code Connectivity:** Instantly share and scan room codes to bridge mobile and desktop devices without typing.
- **Direct DOM Updates for Progress:** Over 200 chunks per second are transferred, but UI progress is throttled to 10 FPS and written directly to the DOM, bypassing React reconciliations to preserve CPU performance.

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

# Optional: Tier 3 HTTP Relay server URL (requires separate backend deployment)
VITE_RELAY_URL=https://your-relay-server.com
```

### Build Steps

1. Install dependencies: `npm install`
2. Run local development server: `npm run dev`
3. Build for production: `npm run build`

## 🔒 Security Model

- **P2P Eavesdrop Prevention:** WebRTC DTLS is mandatory by spec.
- **Relay Eavesdrop Prevention:** All chunks are AES-GCM 256-bit encrypted before leaving the browser. The signaling server (Supabase) and Relay servers never see the plaintext payload or keys.
- **Chunk Corruption:** SHA-256 integrity checks per chunk.
- **Replay Attack:** Unique 96-bit random IV per chunk.
- **CGNAT Collision:** Mitigated via localized router-level ICE subnet hashing, not public IP matching.
