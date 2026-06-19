import React, { useEffect, useRef, useState } from 'react';
import { generateShareUrl } from '../core/discovery';

export function QRModal({ isOpen, onClose, mode, roomCode, myPeerId, onScan }) {
  const [error, setError] = useState('');
  const qrRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    if (isOpen && mode === 'share' && roomCode && qrRef.current) {
      try {
        const url = generateShareUrl(roomCode, myPeerId);
        const qr = window.qrcode(0, 'H');
        qr.addData(url);
        qr.make();
        qrRef.current.innerHTML = qr.createImgTag(5, 0);
      } catch (err) {
        console.error('QR Generate Error:', err);
      }
    }
  }, [isOpen, mode, roomCode, myPeerId]);

  useEffect(() => {
    if (isOpen && mode === 'scan') startScanner();
    return () => stopScanner();
  }, [isOpen, mode]);

  const startScanner = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', true);
        videoRef.current.play();
        requestAnimationFrame(tick);
      }
    } catch {
      setError('Camera access denied or not available.');
    }
  };

  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

  const tick = () => {
    if (!videoRef.current || !canvasRef.current || !isOpen || mode !== 'scan') return;
    if (videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });

      if (code) {
        try {
          const url = new URL(code.data);
          const room = url.searchParams.get('room');
          const peer = url.searchParams.get('peer');
          if (room) {
            stopScanner();
            onScan?.(room, peer);
            onClose();
            return;
          }
        } catch { /* not a URL */ }
      }
    }
    requestAnimationFrame(tick);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.15s_ease]">
      <div className="bg-[#18181b]/50 backdrop-blur-2xl border border-white/10 rounded-2xl p-6 max-w-sm w-full shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] animate-[scaleIn_0.2s_cubic-bezier(0.34,1.56,0.64,1)]">
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-lg font-semibold text-[#fafafa]">
            {mode === 'share' ? 'Share Room Code' : 'Scan QR Code'}
          </h2>
          <button onClick={onClose} className="text-[#a1a1aa] hover:text-[#fafafa] transition-colors">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {mode === 'share' && (
          <div className="text-center">
            <div className="bg-white p-4 rounded-xl inline-block mb-4" ref={qrRef} />
            <p className="text-2xl font-mono tracking-[0.3em] font-bold text-[#ef4444] mb-2">{roomCode}</p>
            <p className="text-sm text-[#a1a1aa]">Scan this code or enter it manually to join.</p>
          </div>
        )}

        {mode === 'scan' && (
          <div className="text-center relative">
            {error ? (
              <div className="p-4 bg-[#ef4444]/10 border border-[#ef4444]/30 rounded-xl text-[#ef4444] text-sm">{error}</div>
            ) : (
              <div className="relative rounded-xl overflow-hidden bg-black aspect-square">
                <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" />
                <canvas ref={canvasRef} className="hidden" />
                <div className="absolute inset-0 border-2 border-[#ef4444]/50 rounded-xl m-8"></div>
              </div>
            )}
            <p className="text-sm text-[#a1a1aa] mt-4">Point your camera at a DonkeyChat QR code.</p>
          </div>
        )}
      </div>
    </div>
  );
}
