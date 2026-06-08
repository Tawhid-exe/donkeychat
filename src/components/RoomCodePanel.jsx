import React, { useState } from 'react';
import { generateShareUrl } from '../core/discovery';
import { QRModal } from './QRModal';

export function RoomCodePanel({ roomCode, onCreateRoom, onJoinRoom, connectToPeer, myPeerId }) {
  const [joinExpanded, setJoinExpanded] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [showCopied, setShowCopied] = useState(false);
  const [qrMode, setQrMode] = useState(null); // 'share' | 'scan' | null

  const handleCopy = async () => {
    if (!roomCode) return;
    const url = generateShareUrl(roomCode);
    try {
      await navigator.clipboard.writeText(url);
      setShowCopied(true);
      setTimeout(() => setShowCopied(false), 2000);
    } catch {
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
    }
  };

  // ── Room code display (after creating a room) ──
  if (roomCode) {
    return (
      <div className="p-4 bg-[#18181b] rounded-xl border border-[#3f3f46]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] uppercase tracking-[0.5px] text-[#a1a1aa] font-bold">Room Code</span>
          <button onClick={handleCopy} className="text-[12px] font-bold text-[#ef4444] hover:text-[#dc2626] transition-colors">
            {showCopied ? '✓ Copied!' : 'Copy Link'}
          </button>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-2xl font-mono font-bold text-[#ef4444] tracking-[0.4em] drop-shadow-[0_0_10px_rgba(239,68,68,0.3)]">{roomCode}</p>
          <button
            onClick={() => setQrMode('share')}
            className="p-2 bg-[#ef4444]/10 text-[#ef4444] rounded-lg hover:bg-[#ef4444]/20 transition-colors"
            title="Show QR Code"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
            </svg>
          </button>
        </div>
        <QRModal isOpen={qrMode !== null} onClose={() => setQrMode(null)} mode={qrMode} roomCode={roomCode} myPeerId={myPeerId} />
      </div>
    );
  }

  // ── Landing: 2 buttons → expand join panel ──
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        {/* Create Room */}
        <button
          onClick={onCreateRoom}
          className="flex-[3] py-3.5 bg-[#ef4444] text-white hover:bg-[#dc2626] rounded-xl text-[15px] font-bold transition-all active:scale-[0.98]"
        >
          Create Secure Room
        </button>

        {/* Join Room */}
        <button
          onClick={() => setJoinExpanded(!joinExpanded)}
          className={`flex-[2] py-3.5 bg-[#09090b] border border-[#27272a] text-[#fafafa] hover:bg-[#18181b] rounded-xl text-[15px] font-semibold transition-all active:scale-[0.98] ${joinExpanded ? 'bg-[#18181b] border-[#3f3f46]' : ''}`}
        >
          Join Room
        </button>
      </div>

      {joinExpanded && (
        <div className="flex flex-col gap-2 animate-[fadeIn_0.15s_ease]">
          <label className="text-[12px] font-semibold text-[#a1a1aa] uppercase tracking-[0.5px]">Enter Room Passcode</label>
          <div className="flex gap-2">
            <input
              autoFocus
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="000000"
              className="flex-1 min-w-0 bg-[#09090b] text-[#fafafa] rounded-xl px-4 py-3 border border-[#3f3f46] focus:outline-none focus:border-[#ef4444] focus:ring-1 focus:ring-[#ef4444]/50 font-mono tracking-[0.4em] text-center text-lg placeholder:tracking-normal placeholder:text-center"
              maxLength={8}
            />
            <button
              onClick={handleJoin}
              className="px-5 py-3 bg-[#ef4444] text-white hover:bg-[#dc2626] rounded-xl text-[15px] font-bold transition-all shadow-[0_0_15px_rgba(239,68,68,0.2)] active:scale-[0.98] flex-shrink-0"
            >
              Connect
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setQrMode('scan')}
              className="w-full py-2.5 bg-transparent border border-[#3f3f46] text-[#a1a1aa] hover:bg-[#27272a] hover:text-[#fafafa] rounded-xl text-[13px] font-semibold transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              Scan QR
            </button>
          </div>
        </div>
      )}

      <QRModal
        isOpen={qrMode !== null}
        onClose={() => setQrMode(null)}
        mode={qrMode}
        roomCode={roomCode}
        myPeerId={myPeerId}
        onScan={(code, peer) => {
          onJoinRoom(code);
          setJoinInput('');
          if (peer && connectToPeer) {
            setTimeout(() => connectToPeer(peer), 1500);
          }
        }}
      />
    </div>
  );
}
