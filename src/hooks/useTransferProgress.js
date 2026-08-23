import { useRef, useCallback, useEffect } from 'react';

export function useTransferProgress(transferId) {
  const barRef = useRef(null);
  const textRef = useRef(null);
  const lastUpdateRef = useRef(0);
  const lastBytesRef = useRef(0);
  
  const updateProgress = useCallback((bytesTransferred, totalBytes) => {
    const now = performance.now();
    const timeDiff = now - lastUpdateRef.current;
    
    if (timeDiff < 100) return;
    
    // Calculate Speed
    const bytesDiff = bytesTransferred - lastBytesRef.current;
    const speedBps = (bytesDiff / timeDiff) * 1000;
    let speedStr = '';
    if (speedBps > 1024 * 1024) {
      speedStr = `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`;
    } else {
      speedStr = `${(speedBps / 1024).toFixed(1)} KB/s`;
    }

    lastUpdateRef.current = now;
    lastBytesRef.current = bytesTransferred;
    
    const pct = Math.min(100, (bytesTransferred / totalBytes) * 100);
    const mbTransferred = (bytesTransferred / (1024 * 1024)).toFixed(1);
    const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
    
    if (barRef.current) {
      barRef.current.style.transform = `scaleX(${pct / 100})`;
    }
    
    if (textRef.current) {
      // Only show speed if not finished
      if (pct < 100 && bytesTransferred > 0) {
        textRef.current.textContent = `${mbTransferred} / ${mbTotal} MB — ${speedStr}`;
      } else {
        textRef.current.textContent = `${mbTransferred} / ${mbTotal} MB`;
      }
    }
  }, []);

  useEffect(() => {
    if (!transferId) return;
    const handler = (e) => {
      if (e.detail.transferId === transferId) {
        updateProgress(e.detail.bytesTransferred, e.detail.totalBytes);
      }
    };
    window.addEventListener('transfer_progress', handler);
    return () => window.removeEventListener('transfer_progress', handler);
  }, [transferId, updateProgress]);

  return { barRef, textRef };
}
