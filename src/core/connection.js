import { activityLog } from '../utils/activityLog';
import {
  generateEphemeralPair,
  exportEphemeralPub,
  deriveSessionKey,
  encryptJSON,
  decryptJSON
} from './e2e';

let cachedIceServers = null;

async function getIceServers() {
  if (cachedIceServers) return cachedIceServers;

  let servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const apiKey = import.meta.env.VITE_METERED_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch(`https://donkeychat.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
      if (response.ok) {
        const meteredServers = await response.json();
        servers = [...servers, ...meteredServers];
        cachedIceServers = servers;
        return servers;
      }
    } catch (e) {
      console.error("Failed to fetch TURN credentials", e);
    }
  }

  // Fallback to static env vars if present
  if (import.meta.env.VITE_TURN_URL && import.meta.env.VITE_TURN_URL !== 'turn:placeholder') {
    servers.push({
      urls: import.meta.env.VITE_TURN_URL,
      username: import.meta.env.VITE_TURN_USER || '',
      credential: import.meta.env.VITE_TURN_PASS || ''
    });
  }

  cachedIceServers = servers;
  return servers;
}

const NUM_TRANSFER_CHANNELS = 4;
const CHAT_CHANNEL_LABEL = 'blaze-chat';

export class BlazeConnection {
  constructor(signaling, localPeerId, remotePeerId, isInitiator) {
    this.signaling = signaling;
    this.localPeerId = localPeerId;
    this.remotePeerId = remotePeerId;
    this.isInitiator = isInitiator;
    this.pc = null;
    this.chatChannel = null;
    this.transferChannels = [];
    this.connectionTier = null;
    // FIX #8: Support multiple handlers per event via array
    this.handlers = {};

    this.wanTimeout = null;
    this.lanTimeout = null;
    // Set to 'lan' by usePeer when connecting via LAN discovery channel
    this.expectedTier = null;

    // E2E session state — key derived via ephemeral ECDH over signaling
    this.sessionKey = null;
    this._ephemeralPriv = null;
    this.sessionReady = new Promise((resolve) => { this._resolveSessionReady = resolve; });
  }

  // FIX #8: on() now supports multiple handlers per event
  on(event, fn) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(fn);
    return this;
  }

  // Remove a specific handler
  off(event, fn) {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter(h => h !== fn);
    }
    return this;
  }

  // Emit event to all handlers
  _emit(event, ...args) {
    if (this.handlers[event]) {
      for (const fn of this.handlers[event]) {
        fn(...args);
      }
    }
  }

  async init(initialSignal = null) {
    const iceServers = await getIceServers();
    this.pc = new RTCPeerConnection({ iceServers });

    // Initiator generates its ephemeral ECDH pair up front so the offer
    // can carry the public half; responder derives on offer receipt.
    if (this.isInitiator) {
      try {
        const pair = await generateEphemeralPair();
        this._ephemeralPriv = pair.privateKey;
        this._ephemeralPubJwk = await exportEphemeralPub(pair.publicKey);
      } catch (e) {
        activityLog.log('error', 'E2E setup failed', e.message);
      }
    }

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.signaling.signal(this.remotePeerId, {
        type: 'ice',
        candidate: candidate.toJSON()
      });
    };

    // FIX #2: Await _detectTier() before firing 'connected' handler
    this.pc.onconnectionstatechange = async () => {
      const state = this.pc.connectionState;

      if (state === 'connected') {
        clearTimeout(this.wanTimeout);
        await this._detectTier();  // Now properly awaited
        this._emit('connected', this.connectionTier);
      }

      if (state === 'failed') {
        this._emit('failed');
      }

      if (state === 'disconnected') {
        // WebRTC disconnected temporarily (e.g. internet dropped but LAN is active).
        // It will try to recover automatically. Do not emit fatal failure.
        console.warn('WebRTC disconnected, attempting to recover via LAN/WAN candidates...');
      }

      if (state === 'closed') {
        this._emit('closed');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        this.pc.restartIce();
      }
    };

    // AP Isolation fast failover (UPDATE 4):
    // LAN-expected connections get 3s before falling back so AP-isolated networks
    // (university, hotel Wi-Fi) don't stall for 10s.
    if (this.expectedTier === 'lan') {
      this.lanTimeout = setTimeout(() => {
        if (this.pc.connectionState !== 'connected') {
          console.info('LAN ICE failed after 3s (AP Isolation likely) — promoting to WAN/TURN');
          this._emit('lan_failed');
          // Do NOT close — TURN candidates still gathering on same PC
          // Start WAN fallback timer from this point
          this.wanTimeout = setTimeout(() => {
            if (this.pc.connectionState !== 'connected') {
              this._emit('ice_timeout');
            }
          }, 10000);
        }
      }, 3000);
    } else {
      // Global / WAN connection — allow full 10 seconds
      this.wanTimeout = setTimeout(() => {
        if (this.pc.connectionState !== 'connected') {
          this._emit('ice_timeout');
        }
      }, 10000);
    }

    if (this.isInitiator) {
      this._createChannels();
    } else {
      this.pc.ondatachannel = ({ channel }) => {
        this._handleIncomingChannel(channel);
      };
    }

    this.signaling.on('signal', (payload) => this._processSignal(payload));

    // Process a signal that arrived before our listener was registered
    // (e.g. an unsolicited offer that triggered this connection's creation).
    if (initialSignal) {
      this._processSignal(initialSignal);
    }

    this.signaling.on('relay_chat', (payload) => {
      if (payload.from === this.remotePeerId && payload.e2e === true) {
        this._decryptAndEmit(payload);
      }
    });

    if (this.isInitiator) {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.signal(this.remotePeerId, {
        type: 'offer',
        sdp: offer.sdp,
        e2ePub: this._ephemeralPubJwk
      });
    }
  }

  async _processSignal(payload) {
    if (payload.from !== this.remotePeerId) return;

    if (payload.type === 'offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(payload));

      // Responder side of the E2E handshake: derive the shared session key
      // from the initiator's ephemeral pubkey, then reply with our own
      // (attached to the SDP answer below).
      if (payload.e2ePub && !this.sessionKey) {
        try {
          const pair = await generateEphemeralPair();
          this._ephemeralPriv = pair.privateKey;
          this._ephemeralPubJwk = await exportEphemeralPub(pair.publicKey);
          this.sessionKey = await deriveSessionKey(
            pair.privateKey, payload.e2ePub, this.signaling.roomId
          );
          this._resolveSessionReady(this.sessionKey);
        } catch (e) {
          activityLog.log('error', 'E2E key exchange failed', e.message);
        }
      }

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signaling.signal(this.remotePeerId, {
        type: 'answer',
        sdp: answer.sdp,
        e2ePub: this._ephemeralPubJwk
      });
    }

    if (payload.type === 'answer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(payload));

      // Initiator side of the E2E handshake — responder replied with its pub
      if (payload.e2ePub && !this.sessionKey && this._ephemeralPriv) {
        try {
          this.sessionKey = await deriveSessionKey(
            this._ephemeralPriv, payload.e2ePub, this.signaling.roomId
          );
          this._resolveSessionReady(this.sessionKey);
        } catch (e) {
          activityLog.log('error', 'E2E key exchange failed', e.message);
        }
      }
    }

    if (payload.type === 'ice') {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {
        // Stale/duplicate candidates can arrive after connect — safe to drop
      }
    }
  }

  async _decryptAndEmit(envelope) {
    if (!this.sessionKey) {
      activityLog.log('warn', 'Encrypted message dropped', 'Session key not ready');
      return;
    }
    try {
      const msg = await decryptJSON(this.sessionKey, envelope);
      this._emit('chat_message', msg);
    } catch {
      activityLog.log('warn', 'Decryption failed', 'Message could not be authenticated');
    }
  }

  _createChannels() {
    this.chatChannel = this.pc.createDataChannel(CHAT_CHANNEL_LABEL, {
      ordered: true
    });
    this._setupChatChannel(this.chatChannel);

    for (let i = 0; i < NUM_TRANSFER_CHANNELS; i++) {
      const dc = this.pc.createDataChannel(`blaze-transfer-${i}`, {
        ordered: true
      });
      this._setupTransferChannel(dc, i);
      this.transferChannels.push(dc);
    }
  }

  _handleIncomingChannel(channel) {
    if (channel.label === CHAT_CHANNEL_LABEL) {
      this.chatChannel = channel;
      this._setupChatChannel(channel);
      return;
    }
    if (channel.label.startsWith('blaze-transfer-')) {
      const idx = parseInt(channel.label.split('-').pop());
      this.transferChannels[idx] = channel;
      this._setupTransferChannel(channel, idx);
    }
  }

  _setupChatChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this._emit('chat_ready');
    channel.onmessage = ({ data }) => {
      try {
        const payload = JSON.parse(data);
        if (payload?.e2e === true && payload.data) {
          this._decryptAndEmit(payload);
        } else {
          // Enforce confidentiality — reject plaintext chat payloads
          activityLog.log('warn', 'Rejected unencrypted payload', 'Data channel');
        }
      } catch (e) {
        console.error('Chat message parse error:', e);
      }
    };
    channel.onerror = (e) => console.error('Chat channel error:', e);
  }

  _setupTransferChannel(channel, index) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      const openCount = this.transferChannels.filter(dc => dc && dc.readyState === 'open').length;
      if (openCount === NUM_TRANSFER_CHANNELS) this._emit('transfer_ready', this.transferChannels);
    };
    channel.onmessage = ({ data }) => {
      this._emit('chunk_received', data, index);
    };
  }

  // FIX #3: _detectTier now returns TIER integer constants, not strings
  async _detectTier() {
    try {
      const stats = await this.pc.getStats();
      let detectedTier = null;

      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const local = stats.get(report.localCandidateId);
          if (local?.candidateType === 'host') {
            detectedTier = 0;  // TIER.LAN
          } else if (local?.candidateType === 'srflx' || local?.candidateType === 'prflx') {
            detectedTier = 1;  // TIER.WAN
          } else if (local?.candidateType === 'relay') {
            detectedTier = 2;  // TIER.TURN
          }
        }
      });

      // If WebRTC is connected but we couldn't determine the type, default to WAN
      if (detectedTier === null && this.pc.connectionState === 'connected') {
        detectedTier = 1;
      }

      if (detectedTier !== null) {
        this.connectionTier = detectedTier;
      }

      this._emit('tier_detected', this.connectionTier);
    } catch (e) {
      console.warn('Tier detection failed:', e);
    }
  }

  async sendChat(message) {
    if (!this.sessionKey) {
      activityLog.log('warn', 'Message dropped', 'E2E session key not ready yet');
      return;
    }
    const envelope = await encryptJSON(this.sessionKey, message);

    if (this.chatChannel?.readyState === 'open') {
      this.chatChannel.send(JSON.stringify(envelope));
    } else if (this.signaling) {
      // Fallback for Tier 3 and 4 (Relay / Async) — ciphertext only,
      // the signaling server never sees plaintext or keys.
      await this.signaling.sendRelayChat({ ...envelope, to: this.remotePeerId });
    }
  }

  // Awaitable for callers that must block until the E2E handshake completes
  getSessionKey() {
    return this.sessionReady;
  }

  close() {
    clearTimeout(this.lanTimeout);
    clearTimeout(this.wanTimeout);
    this.lanTimeout = null;
    this.wanTimeout = null;
    this.transferChannels.forEach(dc => dc?.close());
    this.chatChannel?.close();
    this.pc?.close();
  }
}
