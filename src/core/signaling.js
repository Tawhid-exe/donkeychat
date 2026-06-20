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

export class SignalingChannel {
  constructor(roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.channel = null;
    // FIX: Support multiple handlers per event (array-based)
    this.handlers = {};
  }

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (this.handlers[event]) {
      this.handlers[event] = this.handlers[event].filter(h => h !== handler);
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

    if (!supabase) {
      activityLog.log('error', 'Signaling failed', 'Supabase not configured');
      setTimeout(() => this._emit('ready'), 100);
      return this;
    }

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

      await this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.channel.track(this.presenceData);
          activityLog.log('success', 'Room joined', `Room: ${this.roomId.slice(0, 20)}...`);
          // Force an immediate peers sync — catches peers already online before we joined
          this._broadcastPeers();
          this._emit('ready');
        }
      });
    } catch (err) {
      activityLog.log('error', 'Signaling connect failed', err.message);
      this._emit('ready');
    }

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

  // Relay a chat message through Supabase broadcast (fallback when WebRTC unavailable)
  async sendRelayChat(msg) {
    await this.send('chat', { ...msg, from: this.peerId });
  }



  async disconnect() {
    if (this.channel && supabase) {
      try {
        await this.channel.untrack();
        await supabase.removeChannel(this.channel);
      } catch (e) {}
      this.channel = null;
    }
  }
}
