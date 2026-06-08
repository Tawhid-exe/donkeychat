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
    <div className="p-3 border-t border-gray-800">
      {/* Room code display */}
      {roomCode && (
        <div className="mb-2 p-3 bg-[#2a2a35] rounded-xl relative">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Room Code</span>
            <button
              onClick={handleCopy}
              className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              {showCopied ? '✓ Copied!' : 'Copy Link'}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-lg font-mono font-bold text-blue-300 tracking-[0.3em]">{roomCode}</p>
            <button 
              onClick={() => setQrMode('share')}
              className="p-1.5 bg-blue-500/10 text-blue-400 rounded-lg hover:bg-blue-500/20 transition-colors"
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
            className="flex-1 py-2 px-3 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded-lg text-xs font-medium transition-colors border border-blue-600/30"
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
              className="flex-1 min-w-0 bg-[#2a2a35] text-sm text-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500/50 font-mono tracking-wider"
              maxLength={8}
            />
            <button
              onClick={() => setQrMode('scan')}
              className="px-2 py-2 bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 rounded-lg transition-colors border border-purple-600/30 flex-shrink-0"
              title="Scan QR Code"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
            </button>
            <button
              onClick={handleJoin}
              className="px-3 py-2 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 rounded-lg text-xs font-medium transition-colors border border-emerald-600/30 flex-shrink-0"
            >
              Join
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsJoinMode(true)}
            className="flex-1 py-2 px-3 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 rounded-lg text-xs font-medium transition-colors border border-emerald-600/30"
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
