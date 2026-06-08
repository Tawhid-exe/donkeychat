import React, { useState, useRef, useEffect } from 'react';
import { generateRoomCode, generateShareUrl } from '../core/discovery';
import { QRModal } from './QRModal';

export function RoomCodePanel({ roomCode, onCreateRoom, onJoinRoom }) {
  const [joinInput, setJoinInput] = useState('');
  const [showCopied, setShowCopied] = useState(false);
  const [isJoinMode, setIsJoinMode] = useState(false);
  const [qrMode, setQrMode] = useState(null); // 'share' | 'scan' | null
  const inputRef = useRef(null);

  const handleCopy = async () => {
    if (!roomCode) return;
    const url = generateShareUrl(roomCode);
    try {
      await navigator.clipboard.writeText(url);
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 2000);
    } catch {
      // Fallback
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 2000);
    }
  };

  const handleJoin = () => {
    const code = joinInput.trim().toUpperCase();
    if (code.length >= 4) {
      onJoinRoom(code);
      setJoinInput('');
      setIsJoinMode(false);
    }
  };

  useEffect(() => {
    if (isJoinMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isJoinMode]);

  return (
    <div className="p-3 border-t border-[#3f3f46]">
      {/* Room code display */}
      {roomCode && (
        <div className="mb-2 p-3 bg-[#27272a] rounded-xl relative border border-[#3f3f46]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-[#a1a1aa] font-semibold">Room Code</span>
            <button
              onClick={handleCopy}
              className="text-[10px] text-[#ef4444] hover:text-[#dc2626] transition-colors"
            >
              {showCopied ? '✓ Copied!' : 'Copy Link'}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-lg font-mono font-bold text-[#ef4444] tracking-[0.3em] drop-shadow-[0_0_10px_rgba(239,68,68,0.3)]">{roomCode}</p>
            <button 
              onClick={() => setQrMode('share')}
              className="p-1.5 bg-[#ef4444]/10 text-[#ef4444] rounded-lg hover:bg-[#ef4444]/20 transition-colors"
              title="Show QR Code"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {!roomCode && (
          <button
            onClick={onCreateRoom}
            className="flex-1 py-3 px-3 bg-[#ef4444] text-white hover:bg-[#dc2626] rounded-xl text-sm font-semibold transition-colors shadow-[0_0_15px_rgba(239,68,68,0.2)]"
          >
            Create Room
          </button>
        )}
        {isJoinMode ? (
          <div className="flex-1 flex gap-1">
            <input
              ref={inputRef}
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="Enter code..."
              className="flex-1 min-w-0 bg-[#09090b] text-sm text-[#fafafa] rounded-xl px-3 py-2 border border-[#3f3f46] focus:outline-none focus:border-[#ef4444] focus:ring-1 focus:ring-[#ef4444]/50 font-mono tracking-wider text-center"
              maxLength={8}
            />
            <button
              onClick={() => setQrMode('scan')}
              className="px-3 py-2 bg-[#18181b] text-[#fafafa] hover:bg-[#27272a] rounded-xl transition-colors border border-[#3f3f46] flex-shrink-0"
              title="Scan QR Code"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
            </button>
            <button
              onClick={handleJoin}
              className="px-4 py-2 bg-[#ef4444] text-white hover:bg-[#dc2626] rounded-xl text-sm font-semibold transition-colors flex-shrink-0 shadow-[0_0_15px_rgba(239,68,68,0.2)]"
            >
              Join
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsJoinMode(true)}
            className="flex-1 py-3 px-3 bg-[#18181b] text-[#fafafa] hover:bg-[#27272a] rounded-xl text-sm font-semibold transition-colors border border-[#3f3f46]"
          >
            Join Room
          </button>
        )}
      </div>

      {/* QR Modal */}
      <QRModal 
        isOpen={qrMode !== null} 
        onClose={() => setQrMode(null)} 
        mode={qrMode} 
        roomCode={roomCode}
        onScan={(code) => {
          onJoinRoom(code);
          setIsJoinMode(false);
          setJoinInput('');
        }}
      />
    </div>
  );
}
