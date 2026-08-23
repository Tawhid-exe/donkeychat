import { createClient } from '@supabase/supabase-js';
import { activityLog } from '../utils/activityLog';
import { WebSocketChannel, isRelayConfigured } from './wsChannel';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// How long we wait for a SUBSCRIBED confirmation before deciding the
// signaling backend is unreachable (e.g. paused free-tier project) and
// switching to the backup relay server.
const SUPABASE_READY_TIMEOUT_MS = 6000;

const hasSupabase = SUPABASE_URL && SUPABASE_KEY &&
  !SUPABASE_URL.includes('placeholder') && SUPABASE_URL.startsWith('https://');

let supabase = null;
if (hasSupabase) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

export function isSupabaseConfigured() {
  return hasSupabase;
}

export function getSupabaseClient() {
  return supabase;
}

export function isTransportConfigured() {
  return hasSupabase || isRelayConfigured();
}

// Runtime transport actually in use by the most recent channel connect
let activeTransport = null;

export function getTransportStatus() {
  if (activeTransport) return activeTransport;
  if (hasSupabase) return 'supabase';
  if (isRelayConfigured()) return 'relay';
  return 'none';
}

export class SignalingChannel {
  constructor(roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.channel = null;
    this.handlers = {};
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

  // Resolves 'subscribed' once Realtime confirms the subscription,
  // or 'failed' on error/timeout/unconfigured — lets the failover
  // wrapper decide whether to swap transports.
  connectProbe(presenceData = {}) {
    this.presenceData = presenceData;

    return new Promise((resolve) => {
      if (!supabase) {
        activityLog.log('error', 'Signaling failed', 'Supabase not configured');
        setTimeout(() => {
          this._emit('ready');
          resolve('failed');
        }, 100);
        return;
      }

      let settled = false;
      const settle = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      try {
        this.channel = supabase.channel(`blaze:${this.roomId}`, {
          config: {
            presence: { key: this.peerId },
            broadcast: { self: false }
          }
        });

        this.channel
          .on('broadcast', { event: 'signal' }, ({ payload }) => {
            if (payload.to && payload.to !== this.peerId) return;
            this._emit('signal', payload);
          })
          .on('broadcast', { event: 'chat' }, ({ payload }) => {
            if (payload.to && payload.to !== this.peerId) return;
            this._emit('relay_chat', payload);
          })
          .on('presence', { event: 'sync' }, () => {
            this._broadcastPeers();
          })
          .on('presence', { event: 'join' }, () => {
            this._broadcastPeers();
          })
          .on('presence', { event: 'leave' }, () => {
            this._broadcastPeers();
          });

        this.channel.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            settle('subscribed');
            try {
              await this.channel.track(this.presenceData);
            } catch {
              // presence track can race disconnect — non-fatal
            }
            activityLog.log('success', 'Room joined', `Room: ${this.roomId.slice(0, 20)}...`);
            // Force an immediate peers sync — catches peers already online before we joined
            this._broadcastPeers();
            this._emit('ready');
          } else if (/ERROR|TIMED_OUT|CLOSED/.test(String(status))) {
            settle('failed');
          }
        });
      } catch (err) {
        activityLog.log('error', 'Signaling connect failed', err.message);
        this._emit('ready');
        settle('failed');
      }
    });
  }

  async connect(presenceData = {}) {
    await this.connectProbe(presenceData);
    return this;
  }

  _broadcastPeers() {
    if (!this.channel) return;
    const state = this.channel.presenceState();
    const peers = Object.entries(state)
      .filter(([id]) => id !== this.peerId)
      .map(([id, data]) => ({ id, ...data[data.length - 1] }));
    this._emit('peers', peers);
  }

  async send(event, payload) {
    if (!this.channel) return;
    await this.channel.send({
      type: 'broadcast',
      event,
      payload
    });
  }

  async updatePresence(presenceData) {
    if (!this.channel) return;
    try {
      this.presenceData = presenceData;
      await this.channel.track(presenceData);
    } catch (e) {
      console.warn('Failed to update presence', e);
    }
  }

  async signal(to, data) {
    await this.send('signal', { ...data, from: this.peerId, to });
  }

  // Relay a chat message through the signaling backend's broadcast
  // (fallback when WebRTC unavailable)
  async sendRelayChat(msg) {
    await this.send('chat', { ...msg, from: this.peerId });
  }

  async disconnect() {
    if (this.channel && supabase) {
      try {
        await this.channel.untrack();
        await supabase.removeChannel(this.channel);
      } catch {
        // Channel already gone — nothing to clean up
      }
      this.channel = null;
    }
  }
}

const FORWARD_EVENTS = ['signal', 'relay_chat', 'peers', 'ready'];

// Owns the public interface used by usePeer.js. Handlers attach to the
// wrapper immediately after construction; connect() probes Supabase and
// transparently swaps to the backup WebSocket relay when Supabase is
// unreachable (paused project, network outage, bad keys).
export class AutoSignalingChannel {
  constructor(roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.impl = null;
    this.handlers = {};
    this.presenceData = {};
    this.closedByUser = false;
    this.probeTimer = null;
    this._forwarder = (...args) => this._emit(...args);
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

  _attach(impl) {
    for (const ev of FORWARD_EVENTS) impl.on(ev, this._forwarder);
  }

  _detach(impl) {
    for (const ev of FORWARD_EVENTS) impl.off(ev, this._forwarder);
  }

  async connect(presenceData = {}) {
    this.presenceData = presenceData;

    if (!hasSupabase) {
      if (isRelayConfigured()) {
        activeTransport = 'relay';
        activityLog.log('info', 'Transport', 'Using backup relay server');
        return this._activate(new WebSocketChannel(this.roomId, this.peerId));
      }
      // Nothing configured — legacy no-op path still emits ready so the UI doesn't hang
      activeTransport = 'none';
      setTimeout(() => this._emit('ready'), 100);
      return this;
    }

    const supa = new SignalingChannel(this.roomId, this.peerId);
    this._attach(supa);

    const probe = supa.connectProbe(presenceData);
    const timeoutPromise = new Promise((resolve) => {
      clearTimeout(this.probeTimer);
      this.probeTimer = setTimeout(() => resolve('timeout'), SUPABASE_READY_TIMEOUT_MS);
    });

    let result;
    try {
      result = await Promise.race([probe, timeoutPromise]);
    } finally {
      clearTimeout(this.probeTimer);
    }

    if (result === 'subscribed') {
      activeTransport = 'supabase';
      this.impl = supa;
      return this;
    }

    this._detach(supa);
    try { await supa.disconnect(); } catch { /* best effort */ }

    if (!isRelayConfigured()) {
      activeTransport = 'none';
      activityLog.log('error', 'No backend', 'Supabase unreachable and no relay configured');
      setTimeout(() => this._emit('ready'), 100);
      return this;
    }

    activityLog.log('warn', 'Supabase unreachable', 'Falling back to backup relay server');
    activeTransport = 'relay';
    return this._activate(new WebSocketChannel(this.roomId, this.peerId));
  }

  async _activate(impl) {
    this._attach(impl);
    this.impl = impl;
    await impl.connect(this.presenceData);
    return this;
  }

  send(event, payload) {
    return this.impl ? this.impl.send(event, payload) : Promise.resolve();
  }

  updatePresence(presenceData) {
    this.presenceData = presenceData;
    return this.impl ? this.impl.updatePresence(presenceData) : Promise.resolve();
  }

  signal(to, data) {
    return this.impl ? this.impl.signal(to, data) : Promise.resolve();
  }

  sendRelayChat(msg) {
    return this.impl ? this.impl.sendRelayChat(msg) : Promise.resolve();
  }

  async disconnect() {
    this.closedByUser = true;
    clearTimeout(this.probeTimer);
    if (this.impl) {
      try {
        await this.impl.disconnect();
      } catch {
        // best effort teardown
      }
    }
  }
}

// Synchronous factory — handlers can be attached directly after creation,
// exactly like the old `new SignalingChannel(...)` call sites.
export function createSignalingChannel(roomId, peerId) {
  return new AutoSignalingChannel(roomId, peerId);
}
