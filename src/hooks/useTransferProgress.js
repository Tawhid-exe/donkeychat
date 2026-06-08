import { useRef, useCallback } from 'react';

export function useTransferProgress() {
  const barRef = useRef(null);
  const textRef = useRef(null);
  const lastUpdateRef = useRef(0);
  
  const updateProgress = useCallback((bytesTransferred, totalBytes, chunksReceived, totalChunks) => {
    const now = performance.now();
    
    if (now - lastUpdateRef.current < 100) return;
    lastUpdateRef.current = now;
    
    const pct = Math.min(100, (bytesTransferred / totalBytes) * 100);
    const mbTransferred = (bytesTransferred / (1024 * 1024)).toFixed(1);
    const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
    
    if (barRef.current) {
      barRef.current.style.transform = `scaleX(${pct / 100})`;
    }
    
    if (textRef.current) {
      textRef.current.textContent = `${mbTransferred} / ${mbTotal} MB`;
    }
  }, []);

  return { barRef, textRef, updateProgress };
}
