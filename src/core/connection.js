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

  async init() {
    const iceServers = await getIceServers();
    this.pc = new RTCPeerConnection({ iceServers });

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

      if (state === 'failed' || state === 'disconnected') {
        this._emit('failed');
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

    this.wanTimeout = setTimeout(() => {
      if (this.pc.connectionState !== 'connected') {
        this._emit('ice_timeout');
      }
    }, 10000);

    if (this.isInitiator) {
      this._createChannels();
    } else {
      this.pc.ondatachannel = ({ channel }) => {
        this._handleIncomingChannel(channel);
      };
    }

    this.signaling.on('signal', async (payload) => {
      if (payload.from !== this.remotePeerId) return;

      if (payload.type === 'offer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(payload));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.signal(this.remotePeerId, {
          type: 'answer',
          sdp: answer.sdp
        });
      }

      if (payload.type === 'answer') {
        await this.pc.setRemoteDescription(new RTCSessionDescription(payload));
      }

      if (payload.type === 'ice') {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {}
      }
    });

    if (this.isInitiator) {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signaling.signal(this.remotePeerId, {
        type: 'offer',
        sdp: offer.sdp
      });
    }
  }

  _createChannels() {
    this.chatChannel = this.pc.createDataChannel(CHAT_CHANNEL_LABEL, {
      ordered: true
    });
    this._setupChatChannel(this.chatChannel);

    for (let i = 0; i < NUM_TRANSFER_CHANNELS; i++) {
      const dc = this.pc.createDataChannel(`blaze-transfer-${i}`, {
        ordered: false
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
      const msg = JSON.parse(data);
      this._emit('chat_message', msg);
    };
    channel.onerror = (e) => console.error('Chat channel error:', e);
  }

  _setupTransferChannel(channel, index) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      const allOpen = this.transferChannels.every(
        dc => dc && dc.readyState === 'open'
      );
      if (allOpen) this._emit('transfer_ready', this.transferChannels);
    };
    channel.onmessage = ({ data }) => {
      this._emit('chunk_received', data, index);
    };
  }

  // FIX #3: _detectTier now returns TIER integer constants, not strings
  async _detectTier() {
    try {
      const stats = await this.pc.getStats();
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const local = stats.get(report.localCandidateId);
          if (local?.candidateType === 'host') {
            this.connectionTier = 0;  // TIER.LAN
          } else if (local?.candidateType === 'srflx') {
            this.connectionTier = 1;  // TIER.WAN
          } else if (local?.candidateType === 'relay') {
            this.connectionTier = 2;  // TIER.TURN
          }
        }
      });
      this._emit('tier_detected', this.connectionTier);
    } catch (e) {
      console.warn('Tier detection failed:', e);
    }
  }

  sendChat(message) {
    if (this.chatChannel?.readyState === 'open') {
      this.chatChannel.send(JSON.stringify(message));
    }
  }

  close() {
    clearTimeout(this.lanTimeout);
    clearTimeout(this.wanTimeout);
    this.transferChannels.forEach(dc => dc?.close());
    this.chatChannel?.close();
    this.pc?.close();
  }
}
