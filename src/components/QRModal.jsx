import React, { useEffect, useRef, useState } from 'react';
import { generateShareUrl } from '../core/discovery';

export function QRModal({ isOpen, onClose, mode, roomCode, onScan }) {
  const [error, setError] = useState('');
  const qrRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // Generate QR
  useEffect(() => {
    if (isOpen && mode === 'share' && roomCode && qrRef.current) {
      try {
        const url = generateShareUrl(roomCode);
        const qr = window.qrcode(0, 'H');
        qr.addData(url);
        qr.make();
        qrRef.current.innerHTML = qr.createImgTag(5, 0);
      } catch (err) {
        console.error('QR Generate Error:', err);
      }
    }
  }, [isOpen, mode, roomCode]);

  // Scan QR
  useEffect(() => {
    if (isOpen && mode === 'scan') {
      startScanner();
    }
    return () => {
      stopScanner();
    };
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
    } catch (err) {
      setError('Camera access denied or not available.');
    }
  };

  const stopScanner = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
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
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });

      if (code) {
        try {
          const url = new URL(code.data);
          const room = url.searchParams.get('room');
          if (room) {
            stopScanner();
            onScan(room);
            onClose();
            return;
          }
        } catch (e) {
          // Not a valid URL, ignore
        }
      }
    }
    requestAnimationFrame(tick);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#1c1c24] border border-gray-700 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold text-white">
            {mode === 'share' ? 'Share Room Code' : 'Scan QR Code'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {mode === 'share' && (
          <div className="text-center">
            <div className="bg-white p-4 rounded-xl inline-block mb-4" ref={qrRef}>
              {/* QR Code injected here */}
            </div>
            <p className="text-2xl font-mono tracking-[0.3em] font-bold text-blue-400 mb-2">
              {roomCode}
            </p>
            <p className="text-sm text-gray-400">
              Scan this code or enter the code manually to join.
            </p>
          </div>
        )}

        {mode === 'scan' && (
          <div className="text-center relative">
            {error ? (
              <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
                {error}
              </div>
            ) : (
              <div className="relative rounded-xl overflow-hidden bg-black aspect-square">
                <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" />
                <canvas ref={canvasRef} className="hidden" />
                <div className="absolute inset-0 border-2 border-emerald-500/50 rounded-xl m-8 shadow-[0_0_0_4000px_rgba(0,0,0,0.5)]"></div>
              </div>
            )}
            <p className="text-sm text-gray-400 mt-4">
              Point your camera at a DonkeyChat QR code.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
