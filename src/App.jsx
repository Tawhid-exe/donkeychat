import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useIdentity } from './hooks/useIdentity';
import { usePeer } from './hooks/usePeer';
import { useTransfer } from './hooks/useTransfer';
import { globalMessageStore, createMessage, createFileMessage, createSystemMessage, formatFileSize } from './chat/messages';
import { FileTransfer } from './components/FileTransfer';
import { ActivityLogPanel } from './components/ActivityLogPanel';
import { RoomCodePanel } from './components/RoomCodePanel';
import { TIER_NAMES } from './transfer/engine';
import { isSupabaseConfigured } from './core';

function App() {
  const identity = useIdentity();
  const [customName, setCustomName] = useState('');
  
  useEffect(() => {
    if (identity && !customName) setCustomName(identity.displayName);
  }, [identity]);

  const effectiveIdentity = useMemo(() => {
    return identity ? { ...identity, displayName: customName || identity.displayName } : null;
  }, [identity, customName]);

  const {
    lanPeers, connectToPeer, activeConnection, connectedPeer,
    connectionTier, transferEngine, roomCode, createRoom, joinRoom
  } = usePeer(effectiveIdentity);
  
  const { activeTransfers, sendFile, handleIncomingFile, acceptTransfer } = useTransfer(transferEngine, activeConnection);

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join') || params.get('room');
    if (code && code.length >= 4 && !connectedPeer && !activeConnection) {
      setTimeout(() => joinRoom(code), 1000);
    }
  }, [joinRoom, connectedPeer, activeConnection]);

  useEffect(() => {
    const unsubscribe = globalMessageStore.subscribe(setMessages);
    return () => unsubscribe();
  }, []);

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

    return () => {
      if (activeConnection && handlerRef.current) activeConnection.off('chat_message', handlerRef.current);
    };
  }, [activeConnection, connectedPeer]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (!inputText.trim() || !activeConnection) return;
    const msg = createMessage(inputText, effectiveIdentity.peerId);
    activeConnection.sendChat(msg);
    globalMessageStore.addMessage(msg);
    setInputText('');
  };

  const processFile = async (file) => {
    if (!connectedPeer) return;
    let fileToSend = file;

    if (file.type.startsWith('image/')) {
      try {
        const bitmap = await createImageBitmap(file);
        const MAX_DIM = 1200;
        let w = bitmap.width;
        let h = bitmap.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          if (w > h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
          else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        
        const compressedBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.7));
        const compressedName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
        fileToSend = new File([compressedBlob], compressedName, { type: 'image/jpeg' });
      } catch (err) {
        console.warn('Image compression failed', err);
      }
    }

    globalMessageStore.addMessage(createFileMessage({ fileName: fileToSend.name, fileSize: fileToSend.size }, effectiveIdentity.peerId));
    sendFile(fileToSend, connectedPeer);
  };

  const handleFileSelect = (e) => {
    if (!e.target.files.length) return;
    processFile(e.target.files[0]);
    e.target.value = ''; 
  };

  const handleDragOver = useCallback((e) => { e.preventDefault(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback((e) => { e.preventDefault(); setIsDragging(false); }, []);
  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false);
    if (!e.dataTransfer.files.length || !connectedPeer) return;
    processFile(e.dataTransfer.files[0]);
  }, [connectedPeer]);

  if (!identity) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#09090b] text-[#fafafa]">
        <div className="animate-pulse flex flex-col items-center">
          <div className="w-16 h-16 border-4 border-[#ef4444] border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-[#a1a1aa] text-sm">Generating secure identity...</p>
        </div>
      </div>
    );
  }

  const TIER_DISPLAY = {
    0: { label: 'LAN Direct', color: 'text-emerald-400', dot: 'bg-emerald-500' },
    1: { label: 'WAN P2P', color: 'text-[#ef4444]', dot: 'bg-[#ef4444]' },
    2: { label: 'TURN Relay', color: 'text-yellow-400', dot: 'bg-yellow-500' },
    3: { label: 'HTTP Relay', color: 'text-orange-400', dot: 'bg-orange-500' },
    4: { label: 'Async', color: 'text-red-400', dot: 'bg-red-500' },
  };
  const tierInfo = TIER_DISPLAY[connectionTier] || { label: 'Connecting...', color: 'text-[#a1a1aa]', dot: 'bg-[#a1a1aa]' };
  const supabaseReady = isSupabaseConfigured();

  return (
    <div className="flex h-screen bg-[#09090b] text-[#fafafa] overflow-hidden font-sans" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && connectedPeer && (
        <div className="absolute inset-0 bg-[#09090b]/80 backdrop-blur-sm z-50 flex items-center justify-center border-4 border-dashed border-[#ef4444] m-4 rounded-3xl pointer-events-none">
          <div className="text-2xl font-bold text-[#ef4444] flex flex-col items-center gap-4">
            <span className="text-6xl">📂</span> Drop File to Send
          </div>
        </div>
      )}

      <ActivityLogPanel />

      {!connectedPeer ? (
        // LEGACY UI SETUP SCREEN
        <div className="flex-1 flex items-center justify-center p-4 md:p-6 overflow-y-auto">
          <div className="bg-[#18181b] border border-[#3f3f46] rounded-[16px] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5),0_0_40px_rgba(239,68,68,0.15)] max-w-[540px] w-full flex flex-col overflow-hidden my-auto">
            
            <div className="p-7 text-center border-b border-[#3f3f46]">
              <h1 className="text-[22px] font-bold tracking-tight flex items-center justify-center gap-2">
                <span className="text-2xl">🫏</span> DonkeyChat
              </h1>
              <p className="text-[#a1a1aa] text-[13px] mt-1.5">Encrypted P2P network. Zero traces.</p>
            </div>

            <div className="p-7 flex flex-col gap-5">
              <div className="flex flex-col gap-2">
                <label className="text-[12px] font-semibold text-[#a1a1aa] uppercase tracking-[0.5px]">Nickname</label>
                <input 
                  type="text" 
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="w-full bg-[#09090b] border border-[#3f3f46] text-[#fafafa] p-3.5 rounded-xl text-[15px] transition-all focus:outline-none focus:border-[#ef4444] focus:ring-4 focus:ring-[#ef4444]/15"
                  placeholder="Enter your display name..."
                  maxLength={20}
                />
              </div>

              <RoomCodePanel roomCode={roomCode} onCreateRoom={createRoom} onJoinRoom={joinRoom} />

              <div className="mt-2 text-left">
                <h3 className="text-[14px] text-[#a1a1aa] mb-3 font-medium flex justify-between">
                  Nearby Devices
                  {supabaseReady && <span className="text-emerald-400 font-mono text-xs">{lanPeers.length}</span>}
                </h3>
                
                <div className="flex flex-col gap-2">
                  {!supabaseReady && (
                    <div className="p-3 bg-[#27272a] border border-[#3f3f46] rounded-xl text-center">
                      <p className="text-xs text-[#ef4444] font-medium">⚠️ Setup Required</p>
                      <p className="text-[11px] text-[#a1a1aa] mt-1">Add Supabase to .env.local</p>
                    </div>
                  )}

                  {supabaseReady && lanPeers.length === 0 && (
                    <div className="p-6 text-center border border-[#3f3f46] border-dashed rounded-xl">
                      <p className="text-[#a1a1aa] text-sm animate-pulse">Scanning network...</p>
                    </div>
                  )}

                  {lanPeers.map(peer => (
                    <button
                      key={peer.id}
                      onClick={() => connectToPeer(peer.id, !peer.isWan)}
                      className="flex items-center gap-3 p-3 bg-[#18181b] border border-[#3f3f46] rounded-xl cursor-pointer transition-colors hover:border-[#ef4444] hover:bg-[#27272a] text-left w-full"
                    >
                      <div className="text-2xl">📱</div>
                      <div className="flex-1">
                        <div className="font-semibold text-sm">{peer.displayName}</div>
                        <div className="text-[11px] text-[#a1a1aa]">{peer.os} • {peer.isWan ? 'WAN' : 'LAN'}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#ef4444]/5 border border-[#ef4444]/20 p-4 rounded-xl text-[13px] text-red-300/80 leading-[1.6]">
                <span className="text-[#ef4444] font-bold">How it works:</span> Chat uses relay. Files transfer <strong className="text-red-300/90">directly P2P via WebRTC</strong>. If WebRTC fails, files fall back through relay. Room codes expire in <strong>10 minutes</strong>.
              </div>
            </div>
          </div>
        </div>
      ) : (
        // CONNECTED CHAT VIEW (Fullscreen, Large Texting UI)
        <div className="flex-1 flex flex-col relative w-full h-full max-w-[1200px] mx-auto bg-[#09090b]">
          <div className="h-16 px-4 md:px-6 flex items-center justify-between border-b border-[#3f3f46] bg-[#18181b]/90 backdrop-blur-md z-10 relative shadow-[0_4px_20px_rgba(0,0,0,0.5)]">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-[#ef4444] rounded-full flex items-center justify-center text-white font-bold">
                {lanPeers.find(p => p.id === connectedPeer)?.displayName?.charAt(0) || 'P'}
              </div>
              <div>
                <h2 className="font-semibold text-[#fafafa] text-sm">{lanPeers.find(p => p.id === connectedPeer)?.displayName || 'Peer Connection'}</h2>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${tierInfo.dot} animate-pulse`}></span>
                  <span className={`text-xs ${tierInfo.color}`}>Connected — {tierInfo.label}</span>
                </div>
              </div>
            </div>
            <button onClick={() => window.location.reload()} className="px-3 py-1.5 bg-[#18181b] border border-[#3f3f46] rounded-lg text-xs hover:bg-[#27272a] transition-colors">
              End Session
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-4 relative z-0 custom-scrollbar">
            {messages.map((msg, idx) => {
              const isMe = msg.senderId === effectiveIdentity.peerId;
              const isSystem = msg.type === 'system';

              if (isSystem) {
                return (
                  <div key={idx} className="text-center my-2">
                    <span className="px-4 py-1.5 border border-dashed border-[#3f3f46] bg-transparent rounded-full text-[11px] font-medium text-[#a1a1aa]">{msg.text}</span>
                  </div>
                );
              }

              return (
                <div key={idx} className={`flex flex-col max-w-[85%] md:max-w-[75%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`}>
                  <span className="text-[11px] font-semibold text-[#a1a1aa] mb-1 px-1">
                    {isMe ? 'You' : (lanPeers.find(p => p.id === msg.senderId)?.displayName || 'Peer')}
                  </span>
                  <div className={`${isMe ? 'bg-[#ef4444] text-white rounded-2xl rounded-br-sm' : 'bg-[#18181b] border border-[#3f3f46] text-[#fafafa] rounded-2xl rounded-bl-sm'} px-4 py-3 shadow-sm relative group transition-all`}>
                    {msg.type === 'file' ? (
                      <div className="w-64 md:w-72 mt-1">
                        <FileTransfer
                          meta={msg.meta}
                          status={activeTransfers.find(t => t.meta?.transferId === msg.meta?.transferId)?.status}
                          onAccept={msg.meta?.transferId ? () => acceptTransfer(msg.meta.transferId) : undefined}
                        />
                      </div>
                    ) : (
                      <p className="text-[15px] leading-relaxed whitespace-pre-wrap word-break-all">{msg.text}</p>
                    )}
                    <div className="flex items-center justify-end gap-1 mt-1 opacity-70">
                      <span className="text-[10px]">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {isMe && <span className="text-[10px] text-red-200">✓✓</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-3 md:p-4 bg-[#18181b] border-t border-[#3f3f46] relative z-10">
            <div className="flex items-end gap-2 max-w-4xl mx-auto">
              <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
              <input type="file" accept="image/*" ref={imageInputRef} onChange={handleFileSelect} className="hidden" />
              
              <button onClick={() => fileInputRef.current?.click()} className="w-10 h-10 md:w-11 md:h-11 flex items-center justify-center text-[#fafafa] hover:text-[#ef4444] hover:bg-[#27272a] rounded-full border border-[#3f3f46] transition-colors flex-shrink-0 bg-[#09090b]">
                📎
              </button>
              <button onClick={() => imageInputRef.current?.click()} className="w-10 h-10 md:w-11 md:h-11 flex items-center justify-center text-[#fafafa] hover:text-[#ef4444] hover:bg-[#27272a] rounded-full border border-[#3f3f46] transition-colors flex-shrink-0 bg-[#09090b]">
                🖼️
              </button>
              
              <div className="flex-1 bg-[#09090b] rounded-3xl border border-[#3f3f46] overflow-hidden flex items-center min-h-[44px]">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSendMessage())}
                  placeholder="Type a message..."
                  className="w-full bg-transparent text-[#fafafa] placeholder-[#a1a1aa] px-4 py-3 focus:outline-none resize-none text-[15px]"
                  rows="1"
                />
              </div>
              <button
                onClick={handleSendMessage}
                className="w-11 h-11 md:w-12 md:h-12 bg-[#ef4444] text-white hover:bg-[#dc2626] rounded-full flex items-center justify-center transition-all shadow-[0_0_15px_rgba(239,68,68,0.3)] flex-shrink-0 active:scale-95"
              >
                <svg className="w-5 h-5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
