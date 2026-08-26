import { createClient } from '@supabase/supabase-js';
import { activityLog } from '../utils/activityLog';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

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

const SUBSCRIBE_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 2000;

export class SignalingChannel {
  constructor(roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.channel = null;
    this.handlers = {};
    this.connected = false;
    this._retryCount = 0;
    this._subscribeTimer = null;
    this._closedByUser = false;
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
    if (!supabase) {
      activityLog.log('error', 'Signaling failed', 'Supabase not configured — add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local');
      setTimeout(() => this._emit('error', 'Supabase not configured'), 100);
      return this;
    }

    this._closedByUser = false;
    this._retryCount = 0;
    this._presenceData = presenceData;
    await this._attemptSubscribe();
    return this;
  }

  async _attemptSubscribe() {
    if (this._closedByUser) return;

    try {
      if (this.channel) {
        try { await supabase.removeChannel(this.channel); } catch { /* ignore */ }
      }

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

      this._subscribeTimer = setTimeout(() => {
        if (!this.connected && !this._closedByUser) {
          this._subscribeTimer = null;
          this._handleSubscribeFailure('Supabase Realtime timed out (10s) — server may be unreachable');
        }
      }, SUBSCRIBE_TIMEOUT_MS);

      await this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(this._subscribeTimer);
          this._subscribeTimer = null;
          this.connected = true;
          this._retryCount = 0;
          await this.channel.track(this._presenceData);
          activityLog.log('success', 'Room joined', `Room: ${this.roomId.slice(0, 20)}...`);
          this._broadcastPeers();
          this._emit('ready');
        }
      });
    } catch (err) {
      clearTimeout(this._subscribeTimer);
      this._subscribeTimer = null;
      this._handleSubscribeFailure(err.message);
    }
  }

  _handleSubscribeFailure(reason) {
    if (this._closedByUser) return;

    if (this._retryCount < MAX_RETRIES) {
      this._retryCount++;
      const delay = RETRY_BASE_MS * Math.pow(2, this._retryCount - 1);
      activityLog.log('warn', 'Signaling reconnecting', `Attempt ${this._retryCount}/${MAX_RETRIES} in ${delay}ms — ${reason}`);
      this._emit('reconnecting', { attempt: this._retryCount, maxAttempts: MAX_RETRIES });
      setTimeout(() => this._attemptSubscribe(), delay);
    } else {
      activityLog.log('error', 'Signaling unreachable', `${reason} — falling back to relay`);
      this._emit('error', reason);
    }
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
    if (!this.channel || !this.connected) return;
    await this.channel.send({
      type: 'broadcast',
      event,
      payload
    });
  }

  async updatePresence(presenceData) {
    if (!this.channel || !this.connected) return;
    try {
      this._presenceData = presenceData;
      await this.channel.track(presenceData);
    } catch (e) {
      console.warn('Failed to update presence', e);
    }
  }

  async signal(to, data) {
    await this.send('signal', { ...data, from: this.peerId, to });
  }

  async sendRelayChat(msg) {
    await this.send('chat', { ...msg, from: this.peerId });
  }

  async disconnect() {
    this._closedByUser = true;
    clearTimeout(this._subscribeTimer);
    this._subscribeTimer = null;
    if (this.channel && supabase) {
      try {
        await this.channel.untrack();
      } catch {
        // untrack can race disconnect — non-fatal
      }
      try {
        await supabase.removeChannel(this.channel);
      } catch {
        // Channel already gone — nothing to clean up
      }
      this.channel = null;
    }
    this.connected = false;
  }
}
