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

  async sendFile(file, remotePeerId, transferId, onProgress, onComplete, onError) {
    // If tier not set yet (race condition on connect), wait up to 5s for it to be detected
    if (this.currentTier === null) {
      activityLog.log('info', 'Waiting for tier', 'Tier not yet detected, waiting...');
      let waited = 0;
      while (this.currentTier === null && waited < 5000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
      }
    }

    // FIX #3: currentTier is now an integer, these comparisons work
    if (this.currentTier === TIER.LAN || this.currentTier === TIER.WAN || this.currentTier === TIER.TURN) {
      activityLog.log('info', 'File send started', `${file.name} (${(file.size / 1e6).toFixed(1)}MB) via ${TIER_NAMES[this.currentTier]}`);
      return this._sendViaWebRTC(file, transferId, onProgress, onComplete, onError);
    }

    if (this.currentTier === TIER.HTTP || this.currentTier === TIER.ASYNC) {
      activityLog.log('info', 'File send started', `${file.name} (${(file.size / 1e6).toFixed(1)}MB) via ${TIER_NAMES[this.currentTier]}`);
      return this._sendViaRelay(file, transferId, onProgress, onComplete, onError, this.currentTier);
    }

    // No tier set — likely the race condition wasn't fully resolved
    if (this.currentTier === null) {
      activityLog.log('error', 'No transfer tier', 'Connection tier not yet detected. Try reconnecting.');
      onError(new Error('Connection tier not yet detected. Please wait for the connection to stabilize.'));
      return;
    }
  }

  async _sendViaRelay(file, transferId, onProgress, onComplete, onError, tier) {
    const { Sender } = await import('./sender');
    const { uploadChunkToStorage } = await import('./relay');
    const { parseChunkHeader } = await import('./protocol');
    
    let isHttp = tier === TIER.HTTP;
    const RELAY_URL = import.meta.env.VITE_RELAY_URL || '';
    
    if (isHttp && (!RELAY_URL || RELAY_URL.includes('placeholder'))) {
      onError(new Error('HTTP Relay requires a deployed relay server. Set VITE_RELAY_URL in .env.local.'));
      return;
    }
    
    // Mock channel that uploads to relay/storage instead of WebRTC data channel
    const mockChannel = {
      send: async (packet) => {
        try {
          const buffer = packet.buffer || packet;
          const { seq } = parseChunkHeader(buffer);
          
          if (isHttp) {
            const resp = await fetch(`${RELAY_URL}/transfer/${transferId}/chunk/${seq}`, {
              method: 'PUT',
              body: packet
            });
            if (!resp.ok) throw new Error(`HTTP Relay chunk failed`);
          } else {
            await uploadChunkToStorage(transferId, seq, buffer);
          }
        } catch (err) {
          onError(err);
        }
      }
    };
    
    // Create mock channels for parallel uploading
    const mockChannels = [mockChannel, mockChannel, mockChannel, mockChannel];
    
    this.sender = new Sender(
      mockChannels,
      onProgress,
      onComplete,
      onError,
      transferId
    );
    
    const { meta } = await this.sender.prepareMeta(file);
    meta.tier = tier; // Add tier so receiver knows to pull
    
    if (isHttp) {
      // Initialize HTTP relay transfer on server
      try {
        await fetch(`${RELAY_URL}/transfer/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId, from: this.identity.peerId, to: this.conn.remotePeerId, fileName: file.name, fileSize: file.size, totalChunks: meta.totalChunks })
        });
      } catch (err) {
        onError(new Error('Failed to init HTTP relay: ' + err.message));
        return;
      }
    }
    
    this.conn.sendChat({
      type: 'file_incoming',
      meta: {
        transferId: meta.transferId,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        totalChunks: meta.totalChunks,
        mimeType: meta.mimeType,
        fileHash: meta.fileHash,
        rawKey: meta.rawKey,
        compress: meta.compress ?? false,
        tier: tier
      }
    });

    let readyReceived = false;
    let rejected = false;
    const readyHandler = (msg) => {
      if (msg.type === 'file_ready' && msg.transferId === meta.transferId) {
        readyReceived = true;
      }
      if (msg.type === 'file_rejected' && msg.transferId === meta.transferId) {
        rejected = true;
      }
    };
    this.conn.on('chat_message', readyHandler);

    let waited = 0;
    while (!readyReceived && !rejected && waited < 60000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    this.conn.off('chat_message', readyHandler);

    if (rejected) {
      onError(new Error('Receiver declined the file transfer.'));
      return;
    }

    if (!readyReceived) {
      onError(new Error('Receiver did not respond in time. Transfer cancelled.'));
      return;
    }

    return this.sender.send(file);
  }

  async _sendViaWebRTC(file, transferId, onProgress, onComplete, onError) {
    const { Sender } = await import('./sender');
    this.sender = new Sender(
      this.conn.transferChannels,
      onProgress,
      onComplete,
      onError,
      transferId
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
        rawKey: meta.rawKey,
        compress: meta.compress ?? false
      }
    });

    let readyReceived = false;
    let rejected = false;
    const readyHandler = (msg) => {
      if (msg.type === 'file_ready' && msg.transferId === meta.transferId) {
        readyReceived = true;
      }
      if (msg.type === 'file_rejected' && msg.transferId === meta.transferId) {
        rejected = true;
      }
    };
    this.conn.on('chat_message', readyHandler);

    // Wait up to 60 seconds for receiver to accept (documents need user gesture)
    let waited = 0;
    while (!readyReceived && !rejected && waited < 60000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    this.conn.off('chat_message', readyHandler);

    if (rejected) {
      onError(new Error('Receiver declined the file transfer.'));
      return;
    }

    if (!readyReceived) {
      onError(new Error('Receiver did not respond in time. Transfer cancelled.'));
      return;
    }

    return this.sender.send(file);
  }
}
