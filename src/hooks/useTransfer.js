import { useState, useCallback, useRef, useEffect } from 'react';
import { Receiver } from '../transfer/receiver';
import { activityLog } from '../utils/activityLog';
import { globalMessageStore } from '../chat/messages';

export function useTransfer(transferEngine, activeConnection) {
  const [activeTransfers, setActiveTransfers] = useState([]);
  const receiversRef = useRef(new Map());

  // Handle incoming files
  const handleIncomingFile = useCallback(async (meta) => {
    activityLog.log('info', 'File incoming',
      `${meta.fileName} (${(meta.fileSize / 1e6).toFixed(1)}MB)`);

    const receiver = new Receiver(
      meta,
      (bytes, total, seq, totalChunks) => {
        // Progress updates via direct DOM in FileTransfer component
      },
      (fileHash, blobUrl) => {
        activityLog.log('success', 'File received', `${meta.fileName} — hash: ${fileHash?.slice(0, 12)}...`);
        if (blobUrl) {
          globalMessageStore.updateMessageByTransferId(meta.transferId, { blobUrl });
        }
        // Remove from active transfers on completion
        setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== meta.transferId));
        receiversRef.current.delete(meta.transferId);
      },
      (err) => {
        activityLog.log('error', 'File receive error', err.message);
        receiversRef.current.delete(meta.transferId);
      }
    );

    receiversRef.current.set(meta.transferId, receiver);

    // Images/videos auto-accept and render inline
    const isMedia = meta.mimeType?.startsWith('image/') || meta.mimeType?.startsWith('video/');

    if (isMedia) {
      // Auto-accept media — init receiver immediately
      try {
        await receiver.init();
        activeConnection.sendChat({ type: 'file_ready', transferId: meta.transferId });
      } catch (err) {
        activityLog.log('error', 'Receiver init failed', err.message);
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

  // Accept a pending file transfer
  const acceptTransfer = useCallback(async (transferId) => {
    const transfer = activeTransfers.find(t => t.meta.transferId === transferId);
    if (!transfer || !transfer.receiver) return;

    try {
      await transfer.receiver.init();
      // Send ACK so sender starts streaming
      activeConnection.sendChat({ type: 'file_ready', transferId });
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
    setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
    receiversRef.current.delete(transferId);
    activityLog.log('info', 'Transfer declined', '');
    if (activeConnection) {
      activeConnection.sendChat({ type: 'file_rejected', transferId });
    }
    // Remove the file message from chat
    globalMessageStore.updateMessageByTransferId(transferId, { declined: true });
  }, [activeConnection]);

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
      (bytes, total, seq, totalChunks) => {
        // UI updates via direct DOM
      },
      (hash) => {
        activityLog.log('success', 'File sent', `${file.name} — hash: ${hash?.slice(0, 12)}...`);
        setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
      },
      (err) => {
        activityLog.log('error', 'File send error', err.message);
        setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
      }
    );
  }, [transferEngine]);

  // Install chunk router
  useEffect(() => {
    if (!activeConnection) return;
    const chunkHandler = (data) => {
      const receivers = Array.from(receiversRef.current.values());
      const lastReceiver = receivers[receivers.length - 1];
      if (lastReceiver) {
        lastReceiver.receiveChunk(data);
      }
    };
    activeConnection.on('chunk_received', chunkHandler);
    return () => activeConnection.off('chunk_received', chunkHandler);
  }, [activeConnection]);

  return { activeTransfers, sendFile, handleIncomingFile, acceptTransfer, declineTransfer };
}
