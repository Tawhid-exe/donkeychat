import { activityLog } from '../utils/activityLog';
import {
  generateEphemeralPair,
  exportEphemeralPub,
  deriveSessionKey,
  encryptJSON,
  decryptJSON
} from './e2e';

let cachedIceServers = null;

async function getIceServers(forceRefresh = false) {
  if (!forceRefresh && cachedIceServers) return cachedIceServers;

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
const MAX_ICE_RESTARTS = 3;
const ICE_RESTART_BASE_MS = 1000;
const STALL_CHECK_INTERVAL_MS = 3000;

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
    this.handlers = {};

    this.wanTimeout = null;
    this.lanTimeout = null;
    this.expectedTier = null;

    this.sessionKey = null;
    this._ephemeralPriv = null;
    this.sessionReady = new Promise((resolve) => { this._resolveSessionReady = resolve; });

    this._iceRestartCount = 0;
    this._iceRestartTimer = null;
    this._stallTimer = null;
    this._lastBytesReceived = 0;
    this._closed = false;
  }

  on(event, fn) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(fn);
    return this;
  }

  off(event, fn) {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter(h => h !== fn);
    }
    return this;
  }

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

    if (this.isInitiator) {
      try {
        const pair = await generateEphemeralPair();
        this._ephemeralPriv = pair.privateKey;
        this._ephemeralPubJwk = await exportEphemeralPub(pair.publicKey);
      } catch (e) {
        activityLog.log('warn', 'E2E key generation failed', `${e.message} — chat will use DTLS encryption only`);
      }
    }

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.signaling.signal(this.remotePeerId, {
        type: 'ice',
        candidate: candidate.toJSON()
      });
    };

    this.pc.onconnectionstatechange = async () => {
      const state = this.pc.connectionState;

      if (state === 'connected') {
        clearTimeout(this.wanTimeout);
        this._iceRestartCount = 0;
        await this._detectTier();
        this._emit('connected', this.connectionTier);
        this._startStallDetection();
      }

      if (state === 'failed') {
        this._stopStallDetection();
        if (this._iceRestartCount < MAX_ICE_RESTARTS) {
          this._attemptIceRestart();
        } else {
          this._emit('failed');
        }
      }

      if (state === 'disconnected') {
        console.warn('WebRTC disconnected, attempting to recover...');
      }

      if (state === 'closed') {
        this._stopStallDetection();
        this._emit('closed');
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed' && this._iceRestartCount < MAX_ICE_RESTARTS) {
        this._attemptIceRestart();
      }
    };

    if (this.expectedTier === 'lan') {
      this.lanTimeout = setTimeout(() => {
        if (this.pc && this.pc.connectionState !== 'connected') {
          console.info('LAN ICE failed after 3s — promoting to WAN/TURN');
          this._emit('lan_failed');
          this.wanTimeout = setTimeout(() => {
            if (this.pc && this.pc.connectionState !== 'connected') {
              this._emit('ice_timeout');
            }
          }, 10000);
        }
      }, 3000);
    } else {
      this.wanTimeout = setTimeout(() => {
        if (this.pc && this.pc.connectionState !== 'connected') {
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

    if (initialSignal) {
      this._processSignal(initialSignal);
    }

    this.signaling.on('relay_chat', (payload) => {
      if (payload.from !== this.remotePeerId) return;
      if (payload.e2e === true && payload.data) {
        this._decryptAndEmit(payload);
      } else {
        this._emit('chat_message', payload);
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

  async _attemptIceRestart() {
    this._iceRestartCount++;
    const delay = ICE_RESTART_BASE_MS * Math.pow(2, this._iceRestartCount - 1);
    activityLog.log('warn', 'ICE restarting', `Attempt ${this._iceRestartCount}/${MAX_ICE_RESTARTS} in ${delay}ms`);

    clearTimeout(this._iceRestartTimer);
    this._iceRestartTimer = setTimeout(async () => {
      if (this._closed || !this.pc) return;
      try {
        cachedIceServers = null;
        const freshIce = await getIceServers(true);
        await this.pc.setConfiguration({ iceServers: freshIce });
        this.pc.restartIce();

        if (this.isInitiator) {
          const offer = await this.pc.createOffer({ iceRestart: true });
          await this.pc.setLocalDescription(offer);
          this.signaling.signal(this.remotePeerId, {
            type: 'offer',
            sdp: offer.sdp,
            e2ePub: this._ephemeralPubJwk
          });
        }
      } catch (e) {
        console.error('ICE restart failed:', e);
        if (this._iceRestartCount >= MAX_ICE_RESTARTS) {
          this._emit('failed');
        }
      }
    }, delay);
  }

  _startStallDetection() {
    this._stopStallDetection();
    this._lastBytesReceived = 0;
    let stallCount = 0;
    this._stallTimer = setInterval(async () => {
      if (this._closed || !this.pc || this.pc.connectionState !== 'connected') {
        this._stopStallDetection();
        return;
      }
      try {
        const stats = await this.pc.getStats();
        let totalBytes = 0;
        stats.forEach(report => {
          if (report.type === 'transport') {
            totalBytes += (report.bytesReceived || 0);
          }
        });
        if (totalBytes === this._lastBytesReceived) {
          stallCount++;
          if (stallCount >= 3) {
            activityLog.log('warn', 'Connection stall detected', 'No data flowing for 9s');
            this._emit('stall');
            stallCount = 0;
          }
        } else {
          stallCount = 0;
        }
        this._lastBytesReceived = totalBytes;
      } catch { /* stats not available */ }
    }, STALL_CHECK_INTERVAL_MS);
  }

  _stopStallDetection() {
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
  }

  async _processSignal(payload) {
    if (payload.from !== this.remotePeerId) return;

    if (payload.type === 'offer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(payload));

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
          activityLog.log('warn', 'E2E key exchange failed', `${e.message} — using DTLS encryption`);
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

      if (payload.e2ePub && !this.sessionKey && this._ephemeralPriv) {
        try {
          this.sessionKey = await deriveSessionKey(
            this._ephemeralPriv, payload.e2ePub, this.signaling.roomId
          );
          this._resolveSessionReady(this.sessionKey);
        } catch (e) {
          activityLog.log('warn', 'E2E key exchange failed', `${e.message} — using DTLS encryption`);
        }
      }
    }

    if (payload.type === 'ice') {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {
        // Stale/duplicate candidates — safe to drop
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
          this._emit('chat_message', payload);
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

  async _detectTier() {
    try {
      const stats = await this.pc.getStats();
      let detectedTier = null;

      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const local = stats.get(report.localCandidateId);
          if (local?.candidateType === 'host') {
            detectedTier = 0;
          } else if (local?.candidateType === 'srflx' || local?.candidateType === 'prflx') {
            detectedTier = 1;
          } else if (local?.candidateType === 'relay') {
            detectedTier = 2;
          }
        }
      });

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
    let envelope;
    if (this.sessionKey) {
      envelope = await encryptJSON(this.sessionKey, message);
    } else {
      envelope = { e2e: false, ...message };
    }

    if (this.chatChannel?.readyState === 'open') {
      this.chatChannel.send(JSON.stringify(envelope));
    } else if (this.signaling) {
      await this.signaling.sendRelayChat({ ...envelope, to: this.remotePeerId });
    }
  }

  getSessionKey() {
    return this.sessionReady;
  }

  close() {
    this._closed = true;
    clearTimeout(this.lanTimeout);
    clearTimeout(this.wanTimeout);
    clearTimeout(this._iceRestartTimer);
    this._stopStallDetection();
    this.lanTimeout = null;
    this.wanTimeout = null;
    this._iceRestartTimer = null;
    this.transferChannels.forEach(dc => dc?.close());
    this.chatChannel?.close();
    this.pc?.close();
  }
}
