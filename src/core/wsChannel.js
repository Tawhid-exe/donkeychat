import { activityLog } from '../utils/activityLog';

const RELAY_WS_URL = import.meta.env.VITE_RELAY_WS_URL || '';
const RELAY_TOKEN = import.meta.env.VITE_RELAY_TOKEN || '';

export function isRelayConfigured() {
  return !!(RELAY_WS_URL && !RELAY_WS_URL.includes('placeholder'));
}

function relayUrlWithToken() {
  if (!RELAY_TOKEN) return RELAY_WS_URL;
  const sep = RELAY_WS_URL.includes('?') ? '&' : '?';
  return `${RELAY_WS_URL}${sep}token=${encodeURIComponent(RELAY_TOKEN)}`;
}

// Drop-in replacement for SignalingChannel backed by the self-hosted
// mini relay server (see /server). Emits the same events with the same
// payload shapes: 'signal', 'relay_chat', 'peers', 'ready'.
export class WebSocketChannel {
  constructor(roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.ws = null;
    this.handlers = {};
    this.presenceData = {};
    this.joined = false;
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.outbox = [];
  }

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    }
    return this;
  }

  _emit(event, ...args) {
    if (this.handlers[event]) {
      for (const fn of this.handlers[event]) fn(...args);
    }
  }

  connect(presenceData = {}) {
    this.presenceData = presenceData;

    if (!isRelayConfigured()) {
      activityLog.log('error', 'Relay failed', 'VITE_RELAY_WS_URL not configured');
      setTimeout(() => this._emit('ready'), 100);
      return Promise.resolve(this);
    }

    this._open();
    return Promise.resolve(this);
  }

  _open() {
    let ws;
    try {
      ws = new WebSocket(relayUrlWithToken());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'join',
        room: this.roomId,
        peerId: this.peerId,
        presence: this.presenceData
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          this.joined = true;
          this.reconnectAttempts = 0;
          this._flushOutbox();
          activityLog.log('success', 'Relay joined', `Room: ${this.roomId.slice(0, 20)}...`);
          this._emit('ready');
          break;
        case 'peers':
          this._emit('peers', msg.peers);
          break;
        case 'signal':
          this._emit('signal', msg.payload);
          break;
        case 'relay_chat':
          this._emit('relay_chat', msg.payload);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      this.joined = false;
      if (!this.closedByUser) this._scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  _scheduleReconnect() {
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), delay);
  }

  _sendRaw(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.joined) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    // Queue until the socket is open and joined again
    if (!this.closedByUser && frame.type !== 'join' && frame.type !== 'presence_update') {
      this.outbox.push(frame);
      if (this.outbox.length > 200) this.outbox.shift();
    }
    return false;
  }

  _flushOutbox() {
    const pending = this.outbox.splice(0);
    for (const frame of pending) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(frame));
      }
    }
  }

  async send(event, payload) {
    this._sendRaw({
      type: event === 'chat' ? 'chat' : event,
      payload
    });
  }

  async updatePresence(presenceData) {
    this.presenceData = presenceData;
    this._sendRaw({ type: 'presence_update', presence: presenceData });
  }

  async signal(to, data) {
    await this.send('signal', { ...data, from: this.peerId, to });
  }

  async sendRelayChat(msg) {
    await this.send('chat', { ...msg, from: this.peerId });
  }

  async disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }
}
