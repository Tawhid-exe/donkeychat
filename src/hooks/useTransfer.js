import { useState, useCallback, useRef, useEffect } from 'react';
import { Receiver } from '../transfer/receiver';
import { activityLog } from '../utils/activityLog';
import { globalMessageStore } from '../chat/messages';
import { parseChunkHeader } from '../transfer/protocol';

const PULL_STALL_MS = 500;
const PULL_ERROR_MS = 1000;
// Per-chunk retry budget before declaring the transfer unrecoverable
const PULL_RETRY_BUDGET = 120;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Sequential chunk puller for Tier 3 (HTTP relay) and Tier 4 (Supabase async).
 * Cancellable via entry.control.cancelled; gives up honestly once the retry
 * budget is exhausted instead of polling forever.
 */
const startPullingChunks = async (meta, entry) => {
  const { receiver, control } = entry;
  const isHttp = meta.tier === 3; // TIER.HTTP
  const isAsync = meta.tier === 4; // TIER.ASYNC
  if (!isHttp && !isAsync) return;

  receiver.pullMode = true;

  const { downloadChunkFromStorage, cleanupStorage } = await import('../transfer/relay');
  const intent = isHttp ? 'http' : 'async';

  let seq = 0;
  let budget = PULL_RETRY_BUDGET;

  while (seq < meta.totalChunks) {
    if (control.cancelled || receiver.done || receiver.cancelled) return;

    try {
      let packet;
      try {
        packet = await downloadChunkFromStorage(meta.transferId, seq, intent);
      } catch (e) {
        // Chunk not uploaded yet — wait and retry
        if (e.status === 404 || e.message?.includes('not found') || e.message?.includes('does not exist')) {
          if ((budget -= 2) <= 0) throw new Error('Sender stalled — chunk never arrived.', { cause: e });
          await sleep(PULL_STALL_MS);
          continue;
        }
        throw e;
      }

      const result = await receiver.receiveChunk(packet.buffer || packet);
      if (!result || result.valid === false) {
        // Integrity failure or internal error — pull this chunk again
        if (--budget <= 0) {
          throw new Error(`Chunk ${seq} failed integrity check after ${PULL_RETRY_BUDGET} attempts.`);
        }
        await sleep(PULL_ERROR_MS);
        continue;
      }

      seq++;
      budget = PULL_RETRY_BUDGET;

    } catch (err) {
      activityLog.log('error', 'Chunk pull failed', err.message);
      receiver.onError(err);
      return;
    }
  }

  // Finalization (integrity verification + writer output) is driven by
  // _maybeFinalize once the integrity root arrives over the chat path.

  if (isAsync && !control.cancelled) {
    await cleanupStorage(meta.transferId, meta.totalChunks, 'async').catch(console.error);
  }
};

export function useTransfer(transferEngine, activeConnection) {
  const [activeTransfers, setActiveTransfers] = useState([]);
  // transferId -> { receiver, control: { cancelled: boolean } }
  const receiversRef = useRef(new Map());

  // Handle incoming files
  const handleIncomingFile = useCallback(async (meta) => {
    activityLog.log('info', 'File incoming',
      `${meta.fileName} (${(meta.fileSize / 1e6).toFixed(1)}MB)`);

    const control = { cancelled: false };

    const receiver = new Receiver(
      meta,
      (bytes, total) => {
        window.dispatchEvent(new CustomEvent('transfer_progress', {
          detail: { transferId: meta.transferId, bytesTransferred: bytes, totalBytes: total }
        }));
      },
      (fileHash, blobUrl) => {
        activityLog.log('success', 'File received',
          `${meta.fileName} — verified ${fileHash?.slice(0, 12)}...`);
        if (blobUrl) {
          globalMessageStore.updateMessageByTransferId(meta.transferId, { blobUrl, completed: true });
        } else {
          globalMessageStore.updateMessageByTransferId(meta.transferId, { completed: true });
        }
        // Remove from active transfers on completion
        setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== meta.transferId));
        receiversRef.current.delete(meta.transferId);
      },
      (err) => {
        activityLog.log('error', 'File receive error', err.message);
        globalMessageStore.updateMessageByTransferId(meta.transferId, { declined: true, error: err.message });
        receiversRef.current.delete(meta.transferId);
      },
      activeConnection ? { send: (msg) => activeConnection.sendChat(msg) } : null
    );

    receiversRef.current.set(meta.transferId, { receiver, control });

    // Images/videos auto-accept and render inline
    const isMedia = meta.mimeType?.startsWith('image/') || meta.mimeType?.startsWith('video/');

    if (isMedia) {
      // Auto-accept media — no user gesture available here, so the receiver
      // picks a gesture-less writer mode (blob/OPFS)
      try {
        await receiver.init(false);
        activeConnection.sendChat({ type: 'file_ready', transferId: meta.transferId });
        startPullingChunks(meta, receiversRef.current.get(meta.transferId)); // Pull chunks if tier 3 or 4
      } catch (err) {
        activityLog.log('error', 'Receiver init failed', err.message);
        receiversRef.current.delete(meta.transferId);
        return;
      }
      setActiveTransfers(prev => [...prev, {
        type: 'receive', meta, receiver, status: 'active'
      }]);
    } else {
      // Documents — require user to Accept or Decline
      // Do NOT init yet, do NOT send file_ready yet
      setActiveTransfers(prev => [...prev, {
        type: 'receive', meta, receiver, status: 'pending_accept'
      }]);
    }
  }, [activeConnection]);

  // Accept a pending file transfer — runs inside a click handler, so the
  // receiver may use the File System Access API save picker
  const acceptTransfer = useCallback(async (transferId) => {
    const transfer = activeTransfers.find(t => t.meta.transferId === transferId);
    if (!transfer || !transfer.receiver) return;

    try {
      await transfer.receiver.init(true);
      // Send ACK so sender starts streaming
      activeConnection.sendChat({ type: 'file_ready', transferId });
      startPullingChunks(transfer.meta, receiversRef.current.get(transferId)); // Pull chunks if tier 3 or 4
      setActiveTransfers(prev =>
        prev.map(t =>
          t.meta.transferId === transferId
            ? { ...t, status: 'active' }
            : t
        )
      );
      activityLog.log('success', 'Transfer accepted', transfer.meta.fileName);
    } catch (err) {
      activityLog.log('error', 'Accept failed', err.message);
    }
  }, [activeTransfers, activeConnection]);

  // Decline a pending file transfer
  const declineTransfer = useCallback((transferId) => {
    const entry = receiversRef.current.get(transferId);
    if (entry) entry.control.cancelled = true;
    setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
    receiversRef.current.delete(transferId);
    activityLog.log('info', 'Transfer declined', '');
    if (activeConnection) {
      activeConnection.sendChat({ type: 'file_rejected', transferId });
    }
    // Remove the file message from chat
    globalMessageStore.updateMessageByTransferId(transferId, { declined: true });
  }, [activeConnection]);

  // Cancel an active file transfer
  const cancelTransfer = useCallback((transferId) => {
    const transfer = activeTransfers.find(t => t.meta?.transferId === transferId);

    if (transfer?.type === 'send') {
      transferEngine?.sender?.cancel();
    } else if (transfer?.type === 'receive') {
      const entry = receiversRef.current.get(transferId);
      if (entry) {
        entry.control.cancelled = true;
        entry.receiver?.cancel?.();
      }
    }

    setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
    receiversRef.current.delete(transferId);
    activityLog.log('info', 'Transfer cancelled', '');

    if (activeConnection) {
      activeConnection.sendChat({ type: 'file_rejected', transferId });
    }

    globalMessageStore.updateMessageByTransferId(transferId, { declined: true, error: 'Cancelled' });
  }, [activeTransfers, transferEngine, activeConnection]);

  // Handle outgoing files
  const sendFile = useCallback(async (file, remotePeerId, transferId) => {
    if (!transferEngine) {
      activityLog.log('error', 'Send failed', 'No transfer engine — not connected');
      return;
    }

    activityLog.log('info', 'Sending file', `${file.name} (${(file.size / 1e6).toFixed(1)}MB)`);

    setActiveTransfers(prev => [...prev, {
      type: 'send',
      meta: { fileName: file.name, fileSize: file.size, transferId },
      status: 'active'
    }]);

    await transferEngine.sendFile(
      file,
      remotePeerId,
      transferId,
      (bytes, total) => {
        window.dispatchEvent(new CustomEvent('transfer_progress', {
          detail: { transferId, bytesTransferred: bytes, totalBytes: total }
        }));
      },
      () => {
        activityLog.log('success', 'File sent', `${file.name} — verified by receiver`);
        setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
        globalMessageStore.updateMessageByTransferId(transferId, { completed: true });
      },
      (err) => {
        activityLog.log('error', 'File send error', err.message);
        setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
        globalMessageStore.updateMessageByTransferId(transferId, { declined: true, error: err.message });
      }
    );
  }, [transferEngine]);

  // Install chunk router + transfer control-message router
  useEffect(() => {
    if (!activeConnection) return;

    const chunkHandler = (data) => {
      try {
        const { transferId } = parseChunkHeader(data);
        const entry = receiversRef.current.get(transferId);
        if (entry) {
          entry.receiver.receiveChunk(data);
        }
      } catch (err) {
        console.error('Failed to route chunk:', err);
      }
    };

    const controlHandler = (msg) => {
      if (!msg?.type) return;
      if (msg.type === 'file_stream_end') {
        receiversRef.current.get(msg.transferId)?.receiver?.handleStreamEnd(msg);
      }
      // file_nack / file_complete are consumed sender-side by the engine
    };

    activeConnection.on('chunk_received', chunkHandler);
    activeConnection.on('chat_message', controlHandler);
    return () => {
      activeConnection.off('chunk_received', chunkHandler);
      activeConnection.off('chat_message', controlHandler);
    };
  }, [activeConnection]);

  return { activeTransfers, sendFile, handleIncomingFile, acceptTransfer, declineTransfer, cancelTransfer };
}
