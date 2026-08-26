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

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 2000;

export class WebSocketChannel {
  constructor(roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.ws = null;
    this.handlers = {};
    this.presenceData = {};
    this.joined = false;
    this.connected = false;
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this._retryCount = 0;
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

  async connect(presenceData = {}) {
    this.presenceData = presenceData;
    this.closedByUser = false;
    this._retryCount = 0;

    if (!isRelayConfigured()) {
      activityLog.log('error', 'Relay failed', 'VITE_RELAY_WS_URL not configured');
      setTimeout(() => this._emit('error', 'Relay not configured'), 100);
      return this;
    }

    this._open();
    return this;
  }

  _open() {
    let ws;
    try {
      ws = new WebSocket(relayUrlWithToken());
    } catch {
      this._handleConnectFailure('WebSocket constructor failed');
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
          this.connected = true;
          this.reconnectAttempts = 0;
          this._retryCount = 0;
          this._flushOutbox();
          activityLog.log('success', 'Room joined', `Room: ${this.roomId.slice(0, 20)}...`);
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
      this.connected = false;
      if (!this.closedByUser) {
        this._handleConnectFailure('WebSocket closed');
      }
    };

    ws.onerror = () => {};
  }

  _handleConnectFailure(reason) {
    if (this.closedByUser) return;
    if (this._retryCount < MAX_RETRIES) {
      this._retryCount++;
      const delay = RETRY_BASE_MS * Math.pow(2, this._retryCount - 1);
      activityLog.log('warn', 'Signaling reconnecting', `Attempt ${this._retryCount}/${MAX_RETRIES} in ${delay}ms`);
      this._emit('reconnecting', { attempt: this._retryCount, maxAttempts: MAX_RETRIES });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this._open(), delay);
    } else {
      activityLog.log('error', 'Signaling unreachable', `${reason} — relay server may be sleeping`);
      this._emit('error', reason);
    }
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
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
    this.joined = false;
    this.connected = false;
  }
}
