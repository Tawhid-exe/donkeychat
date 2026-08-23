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

const COMPLETION_TIMEOUT_MS = 45000;

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

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
    const failOnce = once(onError);
    const completeOnce = once(onComplete);

    // If tier not set yet (race condition on connect), wait up to 5s for it to be detected
    if (this.currentTier === null) {
      activityLog.log('info', 'Waiting for tier', 'Tier not yet detected, waiting...');
      let waited = 0;
      while (this.currentTier === null && waited < 5000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
      }
    }

    if (this.currentTier === TIER.LAN || this.currentTier === TIER.WAN || this.currentTier === TIER.TURN) {
      activityLog.log('info', 'File send started', `${file.name} (${(file.size / 1e6).toFixed(1)}MB) via ${TIER_NAMES[this.currentTier]}`);
      return this._sendViaWebRTC(file, transferId, onProgress, completeOnce, failOnce);
    }

    if (this.currentTier === TIER.HTTP || this.currentTier === TIER.ASYNC) {
      activityLog.log('info', 'File send started', `${file.name} (${(file.size / 1e6).toFixed(1)}MB) via ${TIER_NAMES[this.currentTier]}`);
      return this._sendViaRelay(file, transferId, onProgress, completeOnce, failOnce, this.currentTier);
    }

    // No tier set — likely the race condition wasn't fully resolved
    if (this.currentTier === null) {
      activityLog.log('error', 'No transfer tier', 'Connection tier not yet detected. Try reconnecting.');
      failOnce(new Error('Connection tier not yet detected. Please wait for the connection to stabilize.'));
      return;
    }
  }

  /**
   * Shared completion handshake: after the chunk stream ends, wait for the
   * receiver's file_complete ack and compare integrity roots before
   * reporting success.
   */
  async _awaitVerifiedCompletion(sender, file, meta, onComplete, onError) {
    const controlHandler = (msg) => sender.handleControlMessage(msg);
    this.conn.on('chat_message', controlHandler);

    try {
      await sender.send(file);

      if (sender.cancelled) {
        onError(new Error('Transfer cancelled.'));
        return;
      }
      if (sender.failed) return; // onError already fired inside sender

      const receiverRoot = await sender.waitComplete(COMPLETION_TIMEOUT_MS);

      if (sender.cancelled) {
        onError(new Error('Transfer cancelled.'));
        return;
      }
      if (!receiverRoot) {
        throw new Error('Receiver did not confirm completion in time. Transfer state unknown.');
      }
      if (receiverRoot !== sender.localRoot) {
        throw new Error('Receiver integrity hash does not match sender — file corrupted in transit.');
      }

      activityLog.log('success', 'Transfer verified', 'Receiver hash matches');
      onComplete(sender.localRoot, meta.totalChunks);
    } catch (err) {
      onError(err);
    } finally {
      this.conn.off('chat_message', controlHandler);
      sender.dispose();
    }
  }

  async _sendViaRelay(file, transferId, onProgress, onComplete, onError, tier) {
    const { Sender } = await import('./sender');
    const { uploadChunkToStorage, initChunkTransfer, cleanupStorage } = await import('./relay');
    const { parseChunkHeader } = await import('./protocol');

    // 'http' tier always targets the mini relay; 'async' prefers Supabase
    // Storage and falls back to the mini relay automatically (relay.js).
    const intent = tier === TIER.HTTP ? 'http' : 'async';

    // Mock channel that uploads chunks to the selected chunk store instead
    // of a WebRTC data channel. Errors propagate through the returned
    // promise so the upload loop aborts on first failure with one onError.
    const mockChannel = {
      send: async (packet) => {
        const buffer = packet.buffer || packet;
        const { seq } = parseChunkHeader(buffer);
        await uploadChunkToStorage(transferId, seq, buffer, intent);
      }
    };

    // Mock channels for parallel dispatch (round-robin target)
    const mockChannels = [mockChannel, mockChannel, mockChannel, mockChannel];

    const messaging = {
      send: (msg) => this.conn.sendChat(msg)
    };

    this.sender = new Sender(
      mockChannels,
      onProgress,
      () => {},          // completion is owned by _awaitVerifiedCompletion
      onError,
      transferId,
      messaging
    );

    const { meta } = await this.sender.prepareMeta(file);
    meta.tier = tier; // Add tier so receiver knows to pull

    // Register metadata with the store before any chunk can be uploaded
    // (the mini relay requires init first; Supabase mode ignores this)
    try {
      await initChunkTransfer(transferId, {
        transferId,
        from: this.identity.peerId,
        to: this.conn.remotePeerId,
        fileName: file.name,
        fileSize: file.size,
        totalChunks: meta.totalChunks
      }, intent);
    } catch (err) {
      onError(new Error('Failed to initialize chunk store: ' + err.message));
      return;
    }

    this.conn.sendChat({
      type: 'file_incoming',
      meta: {
        transferId: meta.transferId,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        totalChunks: meta.totalChunks,
        chunkSize: meta.chunkSize,
        mimeType: meta.mimeType,
        fileHash: meta.fileHash,
        rawKey: meta.rawKey,
        compress: meta.compress ?? false,
        tier: tier
      }
    });

    const ready = await this._waitForReceiverDecision(transferId, onError);
    if (!ready) return;

    const completeWithCleanup = async (root, totalChunks) => {
      // Sender-side cleanup once verified (HTTP store sweeps via TTL too)
      if (tier === TIER.ASYNC) {
        await cleanupStorage(transferId, totalChunks, 'async').catch(() => {});
      }
      onComplete(root, totalChunks);
    };

    await this._awaitVerifiedCompletion(this.sender, file, meta, completeWithCleanup, onError);
  }

  async _sendViaWebRTC(file, transferId, onProgress, onComplete, onError) {
    const { Sender } = await import('./sender');

    const messaging = {
      send: (msg) => this.conn.sendChat(msg)
    };

    this.sender = new Sender(
      this.conn.transferChannels,
      onProgress,
      () => {},          // completion is owned by _awaitVerifiedCompletion
      onError,
      transferId,
      messaging
    );

    const { meta } = await this.sender.prepareMeta(file);
    this.conn.sendChat({
      type: 'file_incoming',
      meta: {
        transferId: meta.transferId,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        totalChunks: meta.totalChunks,
        chunkSize: meta.chunkSize,
        mimeType: meta.mimeType,
        fileHash: meta.fileHash,
        rawKey: meta.rawKey,
        compress: meta.compress ?? false
      }
    });

    const ready = await this._waitForReceiverDecision(transferId, onError);
    if (!ready) return;

    await this._awaitVerifiedCompletion(this.sender, file, meta, onComplete, onError);
  }

  /** Waits for file_ready / file_rejected. Returns true only when ready. */
  async _waitForReceiverDecision(transferId, onError) {
    let readyReceived = false;
    let rejected = false;
    const readyHandler = (msg) => {
      if (msg.type === 'file_ready' && msg.transferId === transferId) {
        readyReceived = true;
      }
      if (msg.type === 'file_rejected' && msg.transferId === transferId) {
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
      return false;
    }

    if (!readyReceived) {
      onError(new Error('Receiver did not respond in time. Transfer cancelled.'));
      return false;
    }
    return true;
  }
}
