import { activityLog } from '../utils/activityLog';

export const TIER = {
  LAN:     0,
  WAN:     1,
  TURN:    2,
  HTTP:    3,
  ASYNC:   4
};

export const TIER_NAMES = {
  [TIER.LAN]: 'LAN Direct (WebRTC)',
  [TIER.WAN]: 'WAN P2P (WebRTC)',
  [TIER.TURN]: 'TURN Relay (WebRTC)',
  [TIER.HTTP]: 'HTTP Relay (Server)',
  [TIER.ASYNC]: 'Async Storage (Supabase)',
};

export class TransferEngine {
  constructor(blazeConnection, identity) {
    this.conn = blazeConnection;
    this.identity = identity;
    this.currentTier = null;
    this.sender = null;
    this.receiver = null;
  }

  setTier(tier) {
    const oldTier = this.currentTier;
    this.currentTier = tier;

    if (oldTier !== null && oldTier !== tier) {
      activityLog.log('fallback', 'Transfer tier changed',
        `${TIER_NAMES[oldTier] || 'Unknown'} → ${TIER_NAMES[tier] || 'Unknown'}`);
    } else if (tier !== null) {
      activityLog.log('success', 'Transfer tier set', TIER_NAMES[tier] || `Tier ${tier}`);
    }
  }

  async sendFile(file, remotePeerId, onProgress, onComplete, onError) {
    // FIX #3: currentTier is now an integer, these comparisons work
    if (this.currentTier === TIER.LAN || this.currentTier === TIER.WAN || this.currentTier === TIER.TURN) {
      activityLog.log('info', 'File send started', `${file.name} (${(file.size / 1e6).toFixed(1)}MB) via ${TIER_NAMES[this.currentTier]}`);
      return this._sendViaWebRTC(file, onProgress, onComplete, onError);
    }

    // FIX #13: Tier 3 and 4 — proper error messaging instead of crashing
    if (this.currentTier === TIER.HTTP) {
      activityLog.log('fallback', 'HTTP Relay attempted', 'Requires a deployed Bun.js relay server');
      onError(new Error(
        'HTTP Relay requires a deployed relay server. ' +
        'Set VITE_RELAY_URL in .env.local and deploy the relay server.'
      ));
      return;
    }

    if (this.currentTier === TIER.ASYNC) {
      activityLog.log('fallback', 'Async Storage attempted', 'Requires Supabase Storage bucket');
      onError(new Error(
        'Async transfer requires Supabase Storage with a "blaze-transfers" bucket. ' +
        'Configure Supabase in .env.local.'
      ));
      return;
    }

    // No tier set — likely the race condition wasn't fully resolved
    if (this.currentTier === null) {
      activityLog.log('error', 'No transfer tier', 'Connection tier not yet detected. Try reconnecting.');
      onError(new Error('Connection tier not yet detected. Please wait for the connection to stabilize.'));
      return;
    }
  }

  async _sendViaWebRTC(file, onProgress, onComplete, onError) {
    const { Sender } = await import('./sender');
    this.sender = new Sender(
      this.conn.transferChannels,
      onProgress,
      onComplete,
      onError
    );

    const { meta } = await this.sender.prepareMeta(file);
    this.conn.sendChat({
      type: 'file_incoming',
      meta: {
        transferId: meta.transferId,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        totalChunks: meta.totalChunks,
        mimeType: meta.mimeType,
        fileHash: meta.fileHash,
        rawKey: meta.rawKey
      }
    });

    return this.sender.send(file);
  }
}
