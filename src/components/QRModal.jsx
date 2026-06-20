import React, { useEffect, useRef, useState } from 'react';
import { generateShareUrl } from '../core/discovery';
import qrcode from 'qrcode';
import jsQR from 'jsqr';

export function QRModal({ isOpen, onClose, mode, roomCode, myPeerId, onScan }) {
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const qrRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);

  // Generate QR code using bundled npm package (no CDN dependency)
  useEffect(() => {
    if (isOpen && mode === 'share' && roomCode && qrRef.current) {
      const generateQR = async () => {
        try {
          const url = generateShareUrl(roomCode, myPeerId);
          const dataUrl = await qrcode.toDataURL(url, { margin: 1, width: 200, errorCorrectionLevel: 'H' });
          qrRef.current.innerHTML = `<img src="${dataUrl}" alt="QR Code" class="w-full h-full" />`;
        } catch (err) {
          console.error('QR Generate Error:', err);
          if (qrRef.current) {
            qrRef.current.innerHTML = `<p class="text-red-400 text-sm p-4">QR generation failed.<br/>Share the room code manually.</p>`;
          }
        }
      };
      generateQR();
    }
  }, [isOpen, mode, roomCode, myPeerId]);

  useEffect(() => {
    if (isOpen && mode === 'scan') {
      startScanner();
    }
    return () => stopScanner();
  }, [isOpen, mode]);

  const startScanner = async () => {
    setError('');
    setScanning(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', true);
        await videoRef.current.play();
        setScanning(true);
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setError('Camera access was denied. Please allow camera access in your browser settings.');
      } else if (err.name === 'NotFoundError') {
        setError('No camera found on this device.');
      } else {
        setError(`Camera error: ${err.message}`);
      }
    }
  };

  const stopScanner = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setScanning(false);
  };

  const tick = () => {
    if (!videoRef.current || !canvasRef.current) return;
    if (videoRef.current.readyState !== videoRef.current.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Use bundled jsqr — no window.jsQR CDN dependency
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert'
    });

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
      } catch {
        // Not a URL — keep scanning, QR might be partial
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.15s_ease]">
      <div className="bg-[#18181b]/50 backdrop-blur-2xl border border-white/10 rounded-2xl p-6 max-w-sm w-full shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] animate-[scaleIn_0.2s_cubic-bezier(0.34,1.56,0.64,1)]">
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-lg font-semibold text-[#fafafa]">
            {mode === 'share' ? 'Share Room Code' : 'Scan QR Code'}
          </h2>
          <button onClick={() => { stopScanner(); onClose(); }} className="text-[#a1a1aa] hover:text-[#fafafa] transition-colors">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {mode === 'share' && (
          <div className="text-center">
            <div className="bg-white p-4 rounded-xl inline-block mb-4" ref={qrRef} />
            <p className="text-2xl font-mono tracking-[0.3em] font-bold text-[#ef4444] mb-2">{roomCode}</p>
            <p className="text-sm text-[#a1a1aa]">Scan this code or share the room number to join.</p>
          </div>
        )}

        {mode === 'scan' && (
          <div className="text-center">
            {error ? (
              <div className="p-4 bg-[#ef4444]/10 border border-[#ef4444]/30 rounded-xl text-[#ef4444] text-sm mb-3">
                {error}
                <button
                  onClick={startScanner}
                  className="block mt-3 mx-auto px-4 py-2 bg-[#ef4444] text-white rounded-lg text-xs font-semibold"
                >
                  Try Again
                </button>
              </div>
            ) : (
              <div className="relative rounded-xl overflow-hidden bg-black aspect-square">
                <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted />
                <canvas ref={canvasRef} className="hidden" />
                {/* Scanning frame overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-3/5 h-3/5 relative">
                    {/* Corner brackets */}
                    <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-[#ef4444] rounded-tl-md" />
                    <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-[#ef4444] rounded-tr-md" />
                    <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-[#ef4444] rounded-bl-md" />
                    <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-[#ef4444] rounded-br-md" />
                    {/* Scanning line */}
                    {scanning && (
                      <div className="absolute left-0 right-0 h-0.5 bg-[#ef4444]/70 animate-[scanLine_2s_ease-in-out_infinite]" />
                    )}
                  </div>
                </div>
              </div>
            )}
            <p className="text-sm text-[#a1a1aa] mt-4">
              {scanning ? 'Point your camera at a DonkeyChat QR code.' : 'Starting camera...'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
