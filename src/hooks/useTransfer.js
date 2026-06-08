import { useState, useCallback, useRef, useEffect } from 'react';
import { Receiver } from '../transfer/receiver';
import { activityLog } from '../utils/activityLog';
import { globalMessageStore } from '../chat/messages';

export function useTransfer(transferEngine, activeConnection) {
  const [activeTransfers, setActiveTransfers] = useState([]);
  // FIX #8: Track receivers to prevent handler overwrite
  const receiversRef = useRef(new Map());

  // FIX #5: Handle incoming files with accept dialog
  const handleIncomingFile = useCallback(async (meta) => {
    activityLog.log('info', 'File incoming',
      `${meta.fileName} (${(meta.fileSize / 1e6).toFixed(1)}MB)`);

    const receiver = new Receiver(
      meta,
      (bytes, total, seq, totalChunks) => {
        // Progress handled via direct DOM updates in FileTransfer component
      },
      (fileHash, blobUrl) => {
        activityLog.log('success', 'File received', `${meta.fileName} — hash: ${fileHash?.slice(0, 12)}...`);
        if (blobUrl) {
          globalMessageStore.updateMessageByTransferId(meta.transferId, { blobUrl });
        }
        receiversRef.current.delete(meta.transferId);
      },
      (err) => {
        activityLog.log('error', 'File receive error', err.message);
        receiversRef.current.delete(meta.transferId);
      }
    );

    // Store receiver by transferId
    receiversRef.current.set(meta.transferId, receiver);

    // FIX #5: Don't call init() immediately — wait for user gesture
    // The init() is deferred to when the user clicks "Accept" in the UI
    // For auto-accept (small files), we use blob/opfs mode which doesn't need gesture

    // Determine if we need user gesture (FSA mode requires it)
    const isMedia = meta.mimeType?.startsWith('image/') || meta.mimeType?.startsWith('video/');
    const needsGesture = !isMedia && 'showSaveFilePicker' in window &&
      !/iPad|iPhone|iPod/.test(navigator.userAgent);

    if (needsGesture && meta.fileSize <= 2 * 1024 * 1024 * 1024) {
      // Will need FSA — defer init to user action
      // Set a pending state in transfers
      setActiveTransfers(prev => [...prev, {
        type: 'receive',
        meta,
        receiver,
        status: 'pending_accept'  // UI shows "Accept" button
      }]);
    } else {
      // Can use OPFS/blob — auto-init
      try {
        await receiver.init();
        // Send ACK back so sender knows we are ready
        activeConnection.sendChat({ type: 'file_ready', transferId: meta.transferId });
      } catch (err) {
        activityLog.log('error', 'Receiver init failed', err.message);
        return;
      }

      setActiveTransfers(prev => [...prev, {
        type: 'receive',
        meta,
        receiver,
        status: 'active'
      }]);
    }
  }, [activeConnection]);

  // Accept a pending file transfer (provides user gesture for FSA)
  const acceptTransfer = useCallback(async (transferId) => {
    const transfer = activeTransfers.find(
      t => t.meta.transferId === transferId
    );
    if (!transfer || !transfer.receiver) return;

    try {
      await transfer.receiver.init();
      // Send ACK back so sender knows we are ready
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
  }, [activeTransfers]);

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
      },
      (err) => {
        activityLog.log('error', 'File send error', err.message);
      }
    );
  }, [transferEngine]);

  // Early install of chunk router
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

  const declineTransfer = useCallback((transferId) => {
    setActiveTransfers(prev => prev.filter(t => t.meta.transferId !== transferId));
    receiversRef.current.delete(transferId);
    activityLog.log('info', 'Transfer declined', '');
    // Optionally we can send a decline signal to sender, but sender might just timeout or we can send file_rejected
    if (activeConnection) {
      activeConnection.sendChat({ type: 'file_rejected', transferId });
    }
  }, [activeConnection]);

  return { activeTransfers, sendFile, handleIncomingFile, acceptTransfer, declineTransfer };
}
