import { createClient } from '@supabase/supabase-js';
import { activityLog } from '../utils/activityLog';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// FIX #6: Graceful fallback when Supabase credentials are not configured
const hasSupabase = SUPABASE_URL && SUPABASE_KEY &&
  !SUPABASE_URL.includes('placeholder') && SUPABASE_URL.startsWith('https://');

let supabase = null;
if (hasSupabase) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  activityLog.log('info', 'Supabase connected', `URL: ${SUPABASE_URL.slice(0, 30)}...`);
} else {
  activityLog.log('warn', 'Supabase not configured', 'Using local-only mode. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local');
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
    this.handlers = {};
  }

  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }

  async connect(presenceData = {}) {
    if (!supabase) {
      activityLog.log('error', 'Signaling failed', 'Supabase not configured — cannot discover peers');
      // Fire ready handler anyway so the UI doesn't hang
      setTimeout(() => this.handlers['ready']?.(), 100);
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
          if (payload.to !== this.peerId) return;
          this.handlers['signal']?.(payload);
        })
        .on('presence', { event: 'sync' }, () => {
          const state = this.channel.presenceState();
          const peers = Object.entries(state)
            .filter(([id]) => id !== this.peerId)
            .map(([id, data]) => ({ id, ...data[0] }));
          this.handlers['peers']?.(peers);
        })
        .on('presence', { event: 'join' }, ({ newPresences }) => {
          this.handlers['peer_join']?.(newPresences);
        })
        .on('presence', { event: 'leave' }, ({ leftPresences }) => {
          this.handlers['peer_leave']?.(leftPresences);
        });

      await this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.channel.track(presenceData);
          activityLog.log('success', 'Room joined', `Room: ${this.roomId.slice(0, 20)}...`);
          this.handlers['ready']?.();
        }
      });
    } catch (err) {
      activityLog.log('error', 'Signaling connect failed', err.message);
      // Still fire ready so UI doesn't hang
      this.handlers['ready']?.();
    }

    return this;
  }

  async send(event, payload) {
    if (!this.channel) return;
    await this.channel.send({
      type: 'broadcast',
      event,
      payload
    });
  }

  async signal(to, data) {
    await this.send('signal', { ...data, from: this.peerId, to });
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
