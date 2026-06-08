import React, { useState, useEffect, useRef } from 'react';
import { useIdentity } from './hooks/useIdentity';
import { usePeer } from './hooks/usePeer';
import { useTransfer } from './hooks/useTransfer';
import { globalMessageStore, createMessage, createFileMessage, createSystemMessage, formatFileSize } from './chat/messages';
import { FileTransfer } from './components/FileTransfer';
import { ActivityLogPanel } from './components/ActivityLogPanel';
import { RoomCodePanel } from './components/RoomCodePanel';
import { TIER_NAMES } from './transfer/engine';
import { isSupabaseConfigured } from './core';
import { activityLog } from './utils/activityLog';

function App() {
  const identity = useIdentity();
  const {
    lanPeers, connectToPeer, activeConnection, connectedPeer,
    connectionTier, transferEngine, roomCode, createRoom, joinRoom
  } = usePeer(identity);
  const { activeTransfers, sendFile, handleIncomingFile, acceptTransfer } = useTransfer(transferEngine, activeConnection);

  const [activeTab, setActiveTab] = useState('chat');
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const unsubscribe = globalMessageStore.subscribe(setMessages);
    return () => unsubscribe();
  }, []);

  // FIX #9: Register chat_message handler only once per connection
  const handlerRef = useRef(null);
  useEffect(() => {
    if (!activeConnection) return;

    // Remove previous handler if exists
    if (handlerRef.current) {
      // The new connection.js supports off()
      // But since we're switching connections, the old one is gone
    }

    const chatHandler = (msg) => {
      if (msg.type === 'file_incoming') {
        handleIncomingFile(msg.meta);
        globalMessageStore.addMessage(
          createFileMessage(msg.meta, connectedPeer)
        );
      } else {
        globalMessageStore.addMessage(
          createMessage(msg.text, connectedPeer)
        );
      }
    };

    handlerRef.current = chatHandler;
    activeConnection.on('chat_message', chatHandler);

    // Cleanup on connection change
    return () => {
      if (activeConnection && handlerRef.current) {
        activeConnection.off('chat_message', handlerRef.current);
      }
    };
  }, [activeConnection, connectedPeer]); // Removed handleIncomingFile from deps

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (!inputText.trim() || !activeConnection) return;

    const msg = createMessage(inputText, identity.peerId);
    activeConnection.sendChat(msg);
    globalMessageStore.addMessage(msg);
    setInputText('');
  };

  const handleFileSelect = (e) => {
    if (!e.target.files.length || !connectedPeer) return;
    const file = e.target.files[0];

    globalMessageStore.addMessage(
      createFileMessage({ fileName: file.name, fileSize: file.size }, identity.peerId)
    );

    sendFile(file, connectedPeer);
    e.target.value = ''; // Reset input
  };

  if (!identity) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0f0f13] text-white">
        <div className="animate-pulse flex flex-col items-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-gray-400 text-sm">Generating secure identity...</p>
          <p className="text-gray-600 text-xs mt-1">ECDH P-256 keypair</p>
        </div>
      </div>
    );
  }

  // Tier display info
  const TIER_DISPLAY = {
    0: { label: 'LAN Direct', color: 'text-emerald-400', dot: 'bg-emerald-500' },
    1: { label: 'WAN P2P', color: 'text-green-300', dot: 'bg-green-400' },
    2: { label: 'TURN Relay', color: 'text-yellow-400', dot: 'bg-yellow-500' },
    3: { label: 'HTTP Relay', color: 'text-orange-400', dot: 'bg-orange-500' },
    4: { label: 'Async', color: 'text-red-400', dot: 'bg-red-500' },
  };
  const tierInfo = TIER_DISPLAY[connectionTier] || { label: 'Connecting...', color: 'text-gray-400', dot: 'bg-gray-500' };
  const supabaseReady = isSupabaseConfigured();

  return (
    <div className="flex h-screen bg-[#0f0f13] text-gray-100 overflow-hidden font-sans">
      {/* Activity Log Panel (top-left corner) */}
      <ActivityLogPanel />

      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 bg-[#1c1c24] border-r border-gray-800 flex flex-col">
        {/* Header */}
        <div className="h-16 px-4 flex items-center justify-between border-b border-gray-800 bg-[#1c1c24]/90 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white font-bold shadow-lg shadow-blue-500/20">
              {identity.displayName.charAt(0)}
            </div>
            <div>
              <h1 className="font-semibold text-gray-100 text-sm">{identity.displayName}</h1>
              <p className="text-xs text-blue-400">Online • {identity.os}</p>
            </div>
          </div>
          {/* Supabase status indicator */}
          <div className={`w-2 h-2 rounded-full ${supabaseReady ? 'bg-emerald-500' : 'bg-red-500'}`}
            title={supabaseReady ? 'Supabase connected' : 'Supabase not configured'} />
        </div>

        {/* Search */}
        <div className="p-3">
          <div className="relative">
            <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search peers..."
              className="w-full bg-[#2a2a35] text-sm text-gray-200 placeholder-gray-500 rounded-full py-2 pl-10 pr-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
              id="peer-search"
            />
          </div>
        </div>

        {/* Peer List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-between">
            <span>Network Peers</span>
            <span className="text-emerald-400 font-mono">{lanPeers.length}</span>
          </div>

          {!supabaseReady && (
            <div className="px-4 py-4 text-center">
              <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <p className="text-xs text-yellow-300 font-medium">⚠️ Supabase not configured</p>
                <p className="text-[10px] text-yellow-400/60 mt-1">
                  Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local for peer discovery
                </p>
              </div>
            </div>
          )}

          {supabaseReady && lanPeers.length === 0 && (
            <div className="px-4 py-8 text-center">
              <div className="w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-gray-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
                </svg>
              </div>
              <p className="text-gray-500 text-sm">Scanning network...</p>
              <p className="text-gray-600 text-xs mt-1">Probing ICE candidates</p>
            </div>
          )}

          {lanPeers.map(peer => (
            <button
              key={peer.id}
              onClick={() => connectToPeer(peer.id, !peer.isWan)}
              className={`w-full p-3 flex items-center gap-3 hover:bg-[#2a2a35] transition-colors group ${connectedPeer === peer.id ? 'bg-[#2a2a35] border-l-2 border-blue-500' : ''}`}
              id={`peer-${peer.id.slice(0, 8)}`}
            >
              <div className={`w-12 h-12 ${peer.isWan ? 'bg-gradient-to-br from-purple-400 to-pink-500' : 'bg-gradient-to-br from-emerald-400 to-teal-500'} rounded-full flex items-center justify-center text-white font-bold shadow-lg ${peer.isWan ? 'shadow-purple-500/20' : 'shadow-emerald-500/20'}`}>
                {peer.displayName?.charAt(0) || '?'}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="flex justify-between items-baseline mb-0.5">
                  <span className="font-medium text-gray-100 truncate text-sm">{peer.displayName}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs ${peer.isWan ? 'text-purple-400' : 'text-emerald-400'}`}>
                    {peer.isWan ? '🌐 WAN' : '📡 LAN'} • {peer.os}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Room Code Panel — FIX #11 */}
        <RoomCodePanel
          roomCode={roomCode}
          onCreateRoom={createRoom}
          onJoinRoom={joinRoom}
        />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative bg-[#0f0f13]">
        <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#4b5563 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

        {connectedPeer ? (
          <>
            {/* Topbar */}
            <div className="h-16 px-6 flex items-center justify-between border-b border-gray-800 bg-[#1c1c24]/80 backdrop-blur-md z-10 relative">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-gradient-to-br from-emerald-400 to-teal-500 rounded-full flex items-center justify-center text-white font-bold">
                  P
                </div>
                <div>
                  <h2 className="font-semibold text-gray-100 text-sm">Peer Connection</h2>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${tierInfo.dot} animate-pulse`}></span>
                    <span className={`text-xs ${tierInfo.color}`}>
                      Connected — {tierInfo.label}
                    </span>
                  </div>
                </div>
              </div>

              {/* Connection method badges */}
              <div className="flex items-center gap-2">
                <span className="px-2 py-1 bg-[#2a2a35] rounded-full text-[10px] text-gray-400 border border-gray-700/50">
                  E2E Encrypted
                </span>
                <span className="px-2 py-1 bg-[#2a2a35] rounded-full text-[10px] text-gray-400 border border-gray-700/50">
                  4x DataChannels
                </span>
              </div>
            </div>

            {/* Message View */}
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-3 relative z-0 custom-scrollbar">
              {messages.map((msg, idx) => {
                const isMe = msg.senderId === identity.peerId;
                const isSystem = msg.type === 'system';

                if (isSystem) {
                  return (
                    <div key={idx} className="text-center">
                      <span className="px-3 py-1 bg-[#2a2a35] rounded-full text-xs text-gray-500">{msg.text}</span>
                    </div>
                  );
                }

                return (
                  <div key={idx} className={`flex items-end gap-2 max-w-[75%] ${isMe ? 'self-end flex-row-reverse' : ''}`}>
                    <div className={`w-7 h-7 rounded-full flex-shrink-0 ${isMe ? 'bg-gradient-to-br from-blue-500 to-indigo-600' : 'bg-gradient-to-br from-emerald-400 to-teal-500'}`} />
                    <div className={`${isMe ? 'bg-blue-600 shadow-blue-900/20 rounded-br-sm' : 'bg-[#2a2a35] border border-gray-700/30 rounded-bl-sm'} text-white rounded-2xl px-4 py-2.5 shadow-sm`}>
                      {msg.type === 'file' ? (
                        <div className="w-72 mt-1">
                          <FileTransfer
                            meta={msg.meta}
                            status={activeTransfers.find(t => t.meta?.transferId === msg.meta?.transferId)?.status}
                            onAccept={msg.meta?.transferId ? () => acceptTransfer(msg.meta.transferId) : undefined}
                          />
                        </div>
                      ) : (
                        <p className="text-sm leading-relaxed">{msg.text}</p>
                      )}
                      <p className="text-[10px] text-white/30 mt-1">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 bg-[#1c1c24]/90 backdrop-blur-md border-t border-gray-800 relative z-10">
              <div className="flex items-end gap-2 max-w-4xl mx-auto">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  className="hidden"
                  id="file-input"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="p-3 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-full transition-colors flex-shrink-0"
                  title="Attach file"
                  id="attach-file-btn"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                </button>
                <div className="flex-1 bg-[#2a2a35] rounded-2xl border border-gray-700/50 shadow-inner overflow-hidden flex items-center min-h-[44px]">
                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSendMessage())}
                    placeholder="Write a message..."
                    className="w-full bg-transparent text-gray-100 placeholder-gray-500 px-4 py-2.5 focus:outline-none resize-none text-sm"
                    rows="1"
                    id="message-input"
                  />
                </div>
                <button
                  onClick={handleSendMessage}
                  className="p-3 bg-blue-600 text-white hover:bg-blue-500 rounded-full transition-all shadow-lg shadow-blue-900/20 flex-shrink-0 active:scale-95"
                  title="Send message"
                  id="send-message-btn"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center relative z-0">
            <div className="text-center p-8 max-w-md">
              <div className="w-24 h-24 bg-gradient-to-br from-blue-500/10 to-indigo-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-blue-500/20">
                <svg className="w-12 h-12 text-blue-500/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-200 mb-2">Welcome to DonkeyChat</h3>
              <p className="text-gray-500 text-sm mb-6">
                Select a peer from your local network, or create/join a room for connections across the internet.
              </p>

              {!supabaseReady && (
                <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-left mb-4">
                  <p className="text-sm text-yellow-300 font-medium mb-2">⚙️ Setup Required</p>
                  <p className="text-xs text-yellow-400/70 leading-relaxed">
                    Create a <code className="bg-black/30 px-1 rounded">.env.local</code> file with your Supabase credentials:
                  </p>
                  <pre className="mt-2 p-2 bg-black/30 rounded text-[10px] text-gray-400 overflow-x-auto">
{`VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key`}
                  </pre>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-left">
                <div className="p-3 bg-[#1c1c24] rounded-xl border border-gray-800">
                  <p className="text-xs font-medium text-emerald-400 mb-1">📡 LAN Direct</p>
                  <p className="text-[10px] text-gray-500">Same WiFi, no server</p>
                </div>
                <div className="p-3 bg-[#1c1c24] rounded-xl border border-gray-800">
                  <p className="text-xs font-medium text-green-400 mb-1">🌐 WAN P2P</p>
                  <p className="text-[10px] text-gray-500">Across internet, via STUN</p>
                </div>
                <div className="p-3 bg-[#1c1c24] rounded-xl border border-gray-800">
                  <p className="text-xs font-medium text-yellow-400 mb-1">🔄 TURN Relay</p>
                  <p className="text-[10px] text-gray-500">When NAT blocks P2P</p>
                </div>
                <div className="p-3 bg-[#1c1c24] rounded-xl border border-gray-800">
                  <p className="text-xs font-medium text-orange-400 mb-1">☁️ HTTP Relay</p>
                  <p className="text-[10px] text-gray-500">Server fallback</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
