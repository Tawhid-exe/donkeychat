import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useIdentity } from './hooks/useIdentity';
import { usePeer } from './hooks/usePeer';
import { useTransfer } from './hooks/useTransfer';
import { globalMessageStore, createMessage, createFileMessage, formatFileSize } from './chat/messages';
import { FileTransfer } from './components/FileTransfer';
import { ActivityLogPanel } from './components/ActivityLogPanel';
import { RoomCodePanel } from './components/RoomCodePanel';
import { isSupabaseConfigured } from './core';
import { activityLog } from './utils/activityLog';

function App() {
  const identity = useIdentity();
  const [customName, setCustomName] = useState('');

  useEffect(() => {
    if (identity && !customName) setCustomName(identity.displayName);
  }, [identity?.peerId]);

  // Stable identity — only changes when peerId changes, not when name changes
  const stableIdentity = useMemo(() => {
    if (!identity) return null;
    return { ...identity };
  }, [identity?.peerId]);

  const {
    lanPeers, connectToPeer, activeConnection, connectedPeer,
    connectionTier, transferEngine, roomCode, createRoom, joinRoom,
    getSignaling, incomingRequest, pendingRequest, acceptRequest, rejectRequest
  } = usePeer(stableIdentity);

  const { activeTransfers, sendFile, handleIncomingFile, acceptTransfer } = useTransfer(transferEngine, activeConnection);

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const chatAreaRef = useRef(null);

  // Deep Link Auto-Join
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join') || params.get('room');
    if (code && code.length >= 4 && !connectedPeer && !activeConnection) {
      setTimeout(() => joinRoom(code), 800);
    }
  }, []);

  // Message store subscription
  useEffect(() => {
    const unsubscribe = globalMessageStore.subscribe(setMessages);
    return () => unsubscribe();
  }, []);

  // Chat channel handler — works via WebRTC data channel
  const handlerRef = useRef(null);
  useEffect(() => {
    if (!activeConnection) return;

    const chatHandler = (msg) => {
      if (msg.type === 'file_incoming') {
        handleIncomingFile(msg.meta);
        globalMessageStore.addMessage(createFileMessage(msg.meta, connectedPeer));
      } else {
        globalMessageStore.addMessage(createMessage(msg.text, connectedPeer));
      }
    };

    handlerRef.current = chatHandler;
    activeConnection.on('chat_message', chatHandler);
    activeConnection.on('chat_ready', () => setChatReady(true));

    return () => {
      if (activeConnection && handlerRef.current) {
        activeConnection.off('chat_message', handlerRef.current);
      }
    };
  }, [activeConnection, connectedPeer]);

  // Relay chat handler — works via Supabase broadcast (fallback)
  useEffect(() => {
    if (!connectedPeer) return;
    const sig = getSignaling();
    if (!sig) return;

    const relayHandler = (payload) => {
      if (payload.from === connectedPeer) {
        globalMessageStore.addMessage(createMessage(payload.text, connectedPeer));
      }
    };

    sig.on('relay_chat', relayHandler);
    return () => sig.off('relay_chat', relayHandler);
  }, [connectedPeer, getSignaling]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message (tries WebRTC first, falls back to relay) ──
  const handleSendMessage = useCallback(() => {
    if (!inputText.trim() || !connectedPeer) return;

    const displayName = customName || stableIdentity?.displayName || 'You';
    const msg = createMessage(inputText, stableIdentity?.peerId);

    // Try WebRTC data channel first
    if (activeConnection?.chatChannel?.readyState === 'open') {
      activeConnection.sendChat(msg);
    } else {
      // Fallback: send via Supabase broadcast relay
      const sig = getSignaling();
      if (sig) {
        sig.sendRelayChat({ text: inputText, to: connectedPeer });
      }
    }

    globalMessageStore.addMessage(msg);
    setInputText('');
  }, [inputText, connectedPeer, activeConnection, stableIdentity, getSignaling, customName]);

  // ── File handling ──
  const processFile = useCallback(async (file) => {
    if (!connectedPeer) return;
    let fileToSend = file;

    if (file.type.startsWith('image/')) {
      try {
        const bitmap = await createImageBitmap(file);
        const MAX = 1200;
        let w = bitmap.width, h = bitmap.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.7));
        fileToSend = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
      } catch (e) { /* use original */ }
    }

    globalMessageStore.addMessage(createFileMessage({ fileName: fileToSend.name, fileSize: fileToSend.size }, stableIdentity?.peerId));
    sendFile(fileToSend, connectedPeer);
  }, [connectedPeer, stableIdentity, sendFile]);

  const handleFileSelect = (e) => {
    if (!e.target.files.length) return;
    processFile(e.target.files[0]);
    e.target.value = '';
  };

  const handleDragOver = useCallback((e) => { e.preventDefault(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback((e) => { e.preventDefault(); setIsDragging(false); }, []);
  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false);
    if (e.dataTransfer.files.length && connectedPeer) processFile(e.dataTransfer.files[0]);
  }, [connectedPeer, processFile]);

  // ── Loading screen ──
  if (!identity) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#09090b]">
        <div className="flex flex-col items-center">
          <div className="w-14 h-14 border-4 border-[#ef4444] border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-[#a1a1aa] text-sm">Generating secure identity...</p>
        </div>
      </div>
    );
  }

  const TIER_DISPLAY = {
    0: { label: 'LAN Direct', color: '#22c55e', dot: 'bg-emerald-500' },
    1: { label: 'WAN P2P', color: '#ef4444', dot: 'bg-[#ef4444]' },
    2: { label: 'TURN Relay', color: '#eab308', dot: 'bg-yellow-500' },
    3: { label: 'HTTP Relay', color: '#f97316', dot: 'bg-orange-500' },
    4: { label: 'Async', color: '#ef4444', dot: 'bg-red-500' },
  };
  const tierInfo = TIER_DISPLAY[connectionTier] || { label: 'Relay', color: '#a1a1aa', dot: 'bg-[#a1a1aa]' };
  const supabaseReady = isSupabaseConfigured();
  const peerName = lanPeers.find(p => p.id === connectedPeer)?.displayName || 'Peer';

  // ════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-[100dvh] bg-[#09090b] text-[#fafafa] overflow-hidden font-sans relative" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      
      {/* Pending Request Overlay */}
      {pendingRequest && (
        <div className="absolute inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#18181b] border border-[#3f3f46] rounded-2xl p-6 max-w-sm w-full text-center shadow-2xl">
            <div className="w-12 h-12 border-4 border-[#ef4444] border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <h3 className="text-[#fafafa] font-semibold text-lg mb-1">Waiting for Peer</h3>
            <p className="text-[#a1a1aa] text-sm">Request sent. Waiting for them to accept...</p>
          </div>
        </div>
      )}

      {/* Incoming Request Overlay */}
      {incomingRequest && (
        <div className="absolute inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#18181b] border border-[#3f3f46] rounded-2xl p-6 max-w-sm w-full text-center shadow-2xl animate-slideDown">
            <div className="w-16 h-16 bg-[#ef4444]/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">👋</span>
            </div>
            <h3 className="text-[#fafafa] font-semibold text-lg mb-1">{incomingRequest.displayName} wants to connect</h3>
            <p className="text-[#a1a1aa] text-sm mb-6">Start a secure P2P chat session?</p>
            <div className="flex gap-3">
              <button onClick={rejectRequest} className="flex-1 py-3 px-4 bg-transparent border border-[#3f3f46] hover:bg-[#27272a] text-[#fafafa] rounded-xl font-semibold transition-colors">
                Decline
              </button>
              <button onClick={acceptRequest} className="flex-1 py-3 px-4 bg-[#ef4444] hover:bg-[#dc2626] text-white rounded-xl font-semibold transition-colors shadow-lg shadow-red-900/20">
                Accept
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Drag overlay */}
      {isDragging && connectedPeer && (
        <div className="absolute inset-0 bg-[#09090b]/80 backdrop-blur-sm z-50 flex items-center justify-center border-4 border-dashed border-[#ef4444] m-4 rounded-3xl pointer-events-none">
          <div className="text-2xl font-bold text-[#ef4444] flex flex-col items-center gap-4">
            <span className="text-6xl">📂</span> Drop File to Send
          </div>
        </div>
      )}

      {!connectedPeer ? (
        <>
          <ActivityLogPanel />
          {/* ═══════ LANDING / SETUP SCREEN ═══════ */}
        <div className="flex-1 flex items-center justify-center p-4 md:p-6 overflow-y-auto">
          <div className="bg-[#18181b] border border-[#3f3f46] rounded-2xl shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5),0_0_40px_rgba(239,68,68,0.1)] max-w-[500px] w-full flex flex-col overflow-hidden">

            {/* Header */}
            <div className="p-6 pb-4 text-center border-b border-[#3f3f46]">
              <h1 className="text-xl font-bold tracking-tight flex items-center justify-center gap-2">
                <span className="text-2xl">🫏</span> DonkeyChat
              </h1>
              <p className="text-[#a1a1aa] text-[13px] mt-1">Encrypted P2P network. Zero traces.</p>
              {supabaseReady && (
                <div className="mt-3 flex items-center justify-center gap-2 text-xs text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  Relay Server Online
                </div>
              )}
            </div>

            {/* Body */}
            <div className="p-6 flex flex-col gap-5">
              {/* Nickname */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-bold text-[#a1a1aa] uppercase tracking-wider">Nickname</label>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="w-full bg-[#09090b] border border-[#3f3f46] text-[#fafafa] p-3 rounded-xl text-[15px] transition-all focus:outline-none focus:border-[#ef4444] focus:ring-2 focus:ring-[#ef4444]/20"
                  placeholder="Name"
                  maxLength={20}
                />
              </div>

              {/* Room Controls */}
              <RoomCodePanel roomCode={roomCode} onCreateRoom={createRoom} onJoinRoom={joinRoom} />

              {/* Peer list — only shown when peers found */}
              {lanPeers.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-[#a1a1aa] uppercase tracking-wider">Nearby Devices</span>
                    <span className="text-emerald-400 text-xs font-mono">{lanPeers.length}</span>
                  </div>
                  {lanPeers.map(peer => (
                    <button
                      key={peer.id}
                      onClick={() => connectToPeer(peer.id)}
                      className="flex items-center gap-3 p-3 bg-[#09090b] border border-[#3f3f46] rounded-xl transition-all hover:border-[#ef4444] hover:bg-[#18181b] text-left w-full group"
                    >
                      <div className="w-10 h-10 bg-[#ef4444] rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                        {peer.displayName?.charAt(0) || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[14px] text-[#fafafa] truncate">{peer.displayName}</div>
                        <div className="text-[11px] text-[#a1a1aa]">{peer.os} • {peer.isWan ? 'WAN' : 'LAN'}</div>
                      </div>
                      <svg className="w-5 h-5 text-[#3f3f46] group-hover:text-[#ef4444] transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              )}

              {/* Info box */}
              <div className="bg-[#ef4444]/5 border border-[#ef4444]/20 p-3.5 rounded-xl text-[12px] text-[#a1a1aa] leading-[1.7]">
                <span className="text-[#ef4444] font-bold">How it works:</span> Chat uses relay. Files transfer <strong className="text-red-300">directly P2P via WebRTC</strong>. If WebRTC fails, files fall back through relay. Max file size: <strong className="text-red-300">4GB+ (WebRTC) / 100MB (relay)</strong>. Room codes expire in <strong>10 minutes</strong>.
              </div>
            </div>
          </div>
        </div>
        </>
      ) : (
        /* ═══════ TELEGRAM-STYLE CHAT VIEW ═══════ */
        <div className="flex-1 flex flex-col relative w-full h-full bg-[#09090b]">

          {/* Chat Header */}
          <div className="h-14 px-4 flex items-center justify-between border-b border-[#3f3f46] bg-[#18181b] z-10 flex-shrink-0 w-full relative">
            <div className="flex items-center gap-3 min-w-0">
              <button onClick={() => window.location.reload()} className="md:hidden flex-shrink-0 text-[#a1a1aa] hover:text-[#fafafa] transition-colors p-1">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
              <div className="w-9 h-9 bg-[#ef4444] rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                {peerName.charAt(0)}
              </div>
              <div className="min-w-0 pr-2">
                <h2 className="font-semibold text-[#fafafa] text-[14px] truncate">{peerName}</h2>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${tierInfo.dot}`}></span>
                  <span className="text-[11px] truncate" style={{ color: tierInfo.color }}>{tierInfo.label}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden md:block">
                <ActivityLogPanel isChatMode={true} />
              </div>
              <button onClick={() => window.location.reload()} className="px-3 py-1.5 bg-[#09090b] border border-[#3f3f46] rounded-lg text-xs text-[#a1a1aa] hover:text-[#fafafa] hover:bg-[#27272a] transition-colors">
                End
              </button>
            </div>
          </div>

          {/* Chat Messages Area — Telegram style */}
          <div ref={chatAreaRef} className="flex-1 overflow-y-auto relative z-0" style={{ background: '#0a0a0c' }}>
            <div className="max-w-3xl mx-auto px-3 py-4 flex flex-col gap-1">
              {messages.length === 0 && (
                <div className="flex items-center justify-center py-16">
                  <div className="text-center">
                    <div className="w-16 h-16 bg-[#18181b] border border-[#3f3f46] rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg className="w-8 h-8 text-[#3f3f46]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    </div>
                    <p className="text-[#3f3f46] text-sm">Start a conversation</p>
                  </div>
                </div>
              )}
              {messages.map((msg, idx) => {
                const isMe = msg.senderId === stableIdentity?.peerId;
                const isSystem = msg.type === 'system';

                if (isSystem) {
                  return (
                    <div key={idx} className="flex justify-center my-3">
                      <span className="px-3 py-1 bg-[#18181b]/80 rounded-full text-[11px] text-[#a1a1aa] backdrop-blur-sm">{msg.text}</span>
                    </div>
                  );
                }

                // Group consecutive messages from same sender
                const prevMsg = idx > 0 ? messages[idx - 1] : null;
                const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null;
                const isFirst = !prevMsg || prevMsg.senderId !== msg.senderId || prevMsg.type === 'system';
                const isLast = !nextMsg || nextMsg.senderId !== msg.senderId || nextMsg.type === 'system';

                return (
                  <div key={idx} className={`flex ${isMe ? 'justify-end' : 'justify-start'} ${isFirst ? 'mt-2' : 'mt-[2px]'}`}>
                    <div
                      className={`relative max-w-[85%] md:max-w-[65%] px-3 py-[7px] ${
                        isMe
                          ? `bg-[#ef4444] text-white ${isFirst && isLast ? 'rounded-2xl' : isFirst ? 'rounded-2xl rounded-br-md' : isLast ? 'rounded-2xl rounded-tr-md' : 'rounded-xl rounded-r-md'}`
                          : `bg-[#18181b] text-[#fafafa] border border-[#27272a] ${isFirst && isLast ? 'rounded-2xl' : isFirst ? 'rounded-2xl rounded-bl-md' : isLast ? 'rounded-2xl rounded-tl-md' : 'rounded-xl rounded-l-md'}`
                      }`}
                    >
                      {msg.type === 'file' ? (
                        <div className="w-56 md:w-64">
                          <FileTransfer
                            meta={msg.meta}
                            status={activeTransfers.find(t => t.meta?.transferId === msg.meta?.transferId)?.status}
                            onAccept={msg.meta?.transferId ? () => acceptTransfer(msg.meta.transferId) : undefined}
                          />
                        </div>
                      ) : (
                        <p className="text-[14.5px] leading-[1.45] whitespace-pre-wrap break-words">{msg.text}</p>
                      )}
                      {isLast && (
                        <div className={`flex items-center gap-1 mt-0.5 ${isMe ? 'justify-end' : 'justify-start'}`}>
                          <span className={`text-[10px] ${isMe ? 'text-red-200/70' : 'text-[#52525b]'}`}>
                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {isMe && <span className="text-[10px] text-red-200/70">✓✓</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input Bar — Telegram style */}
          <div className="border-t border-[#3f3f46] bg-[#18181b] px-2 py-2 flex-shrink-0 relative z-10">
            <div className="flex items-end gap-1.5 max-w-3xl mx-auto">
              <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
              <input type="file" accept="image/*" ref={imageInputRef} onChange={handleFileSelect} className="hidden" />

              <button onClick={() => fileInputRef.current?.click()} className="w-10 h-10 flex items-center justify-center text-[#71717a] hover:text-[#ef4444] rounded-full transition-colors flex-shrink-0" title="Attach file">
                <svg className="w-[22px] h-[22px]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              </button>

              <div className="flex-1 bg-[#09090b] rounded-2xl border border-[#3f3f46] overflow-hidden flex items-end min-h-[40px] transition-colors focus-within:border-[#52525b]">
                <textarea
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    // Auto-resize
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                      e.target.style.height = 'auto';
                    }
                  }}
                  placeholder="Message"
                  className="w-full bg-transparent text-[#fafafa] placeholder-[#52525b] px-3.5 py-2.5 focus:outline-none resize-none text-[14.5px] leading-[1.35]"
                  rows="1"
                  style={{ maxHeight: '120px' }}
                />
              </div>

              <button
                onClick={() => {
                  handleSendMessage();
                  // Reset textarea height
                  const ta = document.querySelector('textarea');
                  if (ta) ta.style.height = 'auto';
                }}
                disabled={!inputText.trim()}
                className={`w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0 ${
                  inputText.trim()
                    ? 'bg-[#ef4444] text-white hover:bg-[#dc2626] shadow-[0_0_12px_rgba(239,68,68,0.25)] active:scale-90'
                    : 'bg-transparent text-[#3f3f46] cursor-default'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
