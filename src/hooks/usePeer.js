import { useState, useEffect, useCallback, useRef } from 'react';
import { SignalingChannel, BlazeConnection, getRoomCodeFromUrl, generateRoomCode, isSupabaseConfigured } from '../core';
import { TransferEngine, TIER } from '../transfer/engine';
import { activityLog } from '../utils/activityLog';

export function usePeer(identity) {
  const [lanPeers, setLanPeers] = useState([]);
  const [activeConnection, setActiveConnection] = useState(null);
  const activeConnectionRef = useRef(null);
  const [connectedPeer, setConnectedPeer] = useState(null);
  const [connectionTier, setConnectionTier] = useState(null);
  const [transferEngine, setTransferEngine] = useState(null);
  const [roomCode, setRoomCode] = useState(null);
  const [incomingRequest, setIncomingRequest] = useState(null);
  const [pendingRequest, setPendingRequest] = useState(null);

  // Refs to hold mutable state without triggering re-renders
  const lobbySignalingRef = useRef(null);
  const roomSignalingRef = useRef(null);
  const identityRef = useRef(null);
  const pendingRequestRef = useRef(null);
  const initedRef = useRef(false);

  // Keep refs in sync
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    pendingRequestRef.current = pendingRequest;
  }, [pendingRequest]);

  // ── Discovery: join global lobby once ──
  useEffect(() => {
    if (!identity?.peerId || initedRef.current) return;
    initedRef.current = true;

    activityLog.log('info', 'Identity ready', `${identity.displayName} (${identity.os})`);

    if (!isSupabaseConfigured()) {
      activityLog.log('warn', 'No Supabase', 'Peer discovery disabled — configure .env.local');
      return;
    }

    const initLobby = async () => {
      let networkId = 'global_lobby';
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        if (res.ok) {
          const data = await res.json();
          // Hash the IP lightly for privacy in the channel name
          const ipHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(data.ip))))
            .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
          networkId = `lobby_${ipHash}`;
        }
      } catch (e) {
        console.warn('Failed to detect public IP for local discovery fallback to global', e);
      }

      // Join network-specific lobby for presence / online count
      const lobbySig = new SignalingChannel(networkId, identity.peerId);
      lobbySignalingRef.current = lobbySig;

      lobbySig.on('peers', (peers) => {
        setLanPeers(prev => {
          const wanIds = new Set(prev.filter(p => p.isWan).map(p => p.id));
          const lobbyPeers = peers.filter(p => !wanIds.has(p.id));
          const wanPeers = prev.filter(p => p.isWan);
          return [...lobbyPeers, ...wanPeers];
        });
        activityLog.setOnlineCount(peers.length + 1);
      });

      lobbySig.on('signal', async (payload) => {
      if (payload.type === 'chat_request' && payload.from) {
        setIncomingRequest({ from: payload.from, displayName: payload.displayName || 'Peer' });
      } else if (payload.type === 'chat_accept' && payload.from) {
        if (pendingRequestRef.current === payload.from) {
          setPendingRequest(null);
          _startInitiatorConnection(lobbySig, payload.from);
        }
      } else if (payload.type === 'chat_reject' && payload.from) {
        if (pendingRequestRef.current === payload.from) {
          setPendingRequest(null);
          activityLog.log('error', 'Connection rejected', 'User denied the chat request');
        }
      } else if (payload.type === 'offer' && payload.from) {
        // Fallback for direct WebRTC offers
        _handleIncomingConnection(lobbySig, payload.from);
      }
    });

      lobbySig.connect({
        displayName: identity.displayName,
        os: identity.os
      });

      // Check URL for room code
      const urlRoom = getRoomCodeFromUrl();
      if (urlRoom) {
        setRoomCode(urlRoom);
        activityLog.log('info', 'Room code from URL', urlRoom);
        _joinRoom(urlRoom);
      }
    };

    initLobby();

    return () => {
      if (lobbySignalingRef.current) lobbySignalingRef.current.disconnect();
      if (roomSignalingRef.current) roomSignalingRef.current.disconnect();
      initedRef.current = false;
    };
  }, [identity?.peerId]);

  // ── Handle incoming P2P connection (responder side) ──
  const _handleIncomingConnection = useCallback(async (sig, remotePeerId) => {
    if (activeConnectionRef.current) return;
    
    activityLog.log('info', 'Incoming connection', `From ${remotePeerId}`);

    const id = identityRef.current;
    if (!id) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, false);
    activeConnectionRef.current = conn;

    const engine = new TransferEngine(conn, id);

    conn.on('connected', (tier) => {
      setConnectionTier(tier);
      engine.setTier(tier);
      activityLog.log('success', 'P2P connected (responder)', `Tier: ${tier}`);
    });

    conn.on('tier_detected', (tier) => {
      setConnectionTier(tier);
      engine.setTier(tier);
    });

    conn.on('failed', () => {
      activityLog.log('error', 'Connection failed', 'P2P connection dropped');
      import('../chat/messages').then(({ globalMessageStore }) => {
        globalMessageStore.addMessage({
          id: crypto.randomUUID(),
          text: 'The other user has left the chat. Redirecting...',
          type: 'system',
          senderId: 'system',
          timestamp: Date.now()
        });
      });
      setTimeout(() => {
        activeConnectionRef.current = null;
        setActiveConnection(null);
        setConnectedPeer(null);
        setConnectionTier(null);
      }, 3000);
    });

    conn.init();

    setActiveConnection(conn);
    setConnectedPeer(remotePeerId);
    setTransferEngine(engine);
  }, []);

  // ── Join a room by code ──
  const _joinRoom = useCallback((code) => {
    const id = identityRef.current;
    if (!id) return;

    const sig = new SignalingChannel(`room_${code}`, id.peerId);
    roomSignalingRef.current = sig;

    sig.on('peers', (peers) => {
      setLanPeers(prev => {
        const existingIds = new Set(prev.map(p => p.id));
        const newPeers = peers.filter(p => !existingIds.has(p.id));
        return [...prev, ...newPeers.map(p => ({ ...p, isWan: true }))];
      });
    });

    // Listen for incoming offers in this room too
    sig.on('signal', async (payload) => {
      if (payload.type === 'chat_request' && payload.from) {
        setIncomingRequest({ from: payload.from, displayName: payload.displayName || 'Peer' });
      } else if (payload.type === 'chat_accept' && payload.from) {
        if (pendingRequestRef.current === payload.from) {
          setPendingRequest(null);
          _startInitiatorConnection(sig, payload.from);
        }
      } else if (payload.type === 'chat_reject' && payload.from) {
        if (pendingRequestRef.current === payload.from) {
          setPendingRequest(null);
          activityLog.log('error', 'Connection rejected', 'User denied the chat request');
        }
      } else if (payload.type === 'offer' && payload.from) {
        _handleIncomingConnection(sig, payload.from);
      }
    });

    sig.connect({ displayName: id.displayName, os: id.os });
    activityLog.log('success', 'Room joined', `Room: ${code}`);
  }, [_handleIncomingConnection]);

  // ── Connect to a specific peer (initiator side) ──
  const connectToPeer = useCallback(async (remotePeerId) => {
    const id = identityRef.current;
    if (!id) return;

    if (!lobbySignalingRef.current && !roomSignalingRef.current) {
      activityLog.log('error', 'No signaling', 'Not connected to any channel');
      return;
    }

    activityLog.log('info', 'Sending request', `To peer: ${remotePeerId.slice(0, 8)}...`);
    setPendingRequest(remotePeerId);
    
    // Send on all available channels to ensure delivery
    const payload = { type: 'chat_request', displayName: id.displayName };
    if (roomSignalingRef.current) roomSignalingRef.current.signal(remotePeerId, payload);
    if (lobbySignalingRef.current) lobbySignalingRef.current.signal(remotePeerId, payload);
  }, []);

  const _startInitiatorConnection = useCallback(async (sig, remotePeerId) => {
    const id = identityRef.current;
    if (!id) return;

    if (activeConnectionRef.current) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, true);
    activeConnectionRef.current = conn;
    const engine = new TransferEngine(conn, id);

    conn.on('connected', (tier) => {
      setConnectionTier(tier);
      engine.setTier(tier);
      activityLog.log('success', 'P2P connected', `Tier: ${tier}`);
    });

    conn.on('tier_detected', (tier) => {
      setConnectionTier(tier);
      engine.setTier(tier);
    });

    conn.on('lan_failed', () => {
      activityLog.log('fallback', 'LAN failed → WAN/TURN', 'AP Isolation detected');
    });

    conn.on('ice_timeout', () => {
      activityLog.log('error', 'WebRTC timeout', 'All ICE candidates failed — using relay chat');
    });

    conn.on('failed', () => {
      activityLog.log('error', 'Connection failed', 'P2P connection dropped');
      import('../chat/messages').then(({ globalMessageStore }) => {
        globalMessageStore.addMessage({
          id: crypto.randomUUID(),
          text: 'The other user has left the chat. Redirecting...',
          type: 'system',
          senderId: 'system',
          timestamp: Date.now()
        });
      });
      setTimeout(() => {
        activeConnectionRef.current = null;
        setActiveConnection(null);
        setConnectedPeer(null);
        setConnectionTier(null);
      }, 3000);
    });

    await conn.init();

    setActiveConnection(conn);
    setConnectedPeer(remotePeerId);
    setTransferEngine(engine);

    return conn;
  }, []);

  const acceptRequest = useCallback(() => {
    if (!incomingRequest) return;
    const payload = { type: 'chat_accept' };
    
    let activeSig = null;
    if (roomSignalingRef.current) {
      roomSignalingRef.current.signal(incomingRequest.from, payload);
      activeSig = roomSignalingRef.current;
    }
    if (lobbySignalingRef.current) {
      lobbySignalingRef.current.signal(incomingRequest.from, payload);
      activeSig = activeSig || lobbySignalingRef.current;
    }
    
    if (activeSig) {
      _handleIncomingConnection(activeSig, incomingRequest.from);
    }
    setIncomingRequest(null);
  }, [incomingRequest, _handleIncomingConnection]);

  const rejectRequest = useCallback(() => {
    if (incomingRequest) {
      const payload = { type: 'chat_reject' };
      if (roomSignalingRef.current) roomSignalingRef.current.signal(incomingRequest.from, payload);
      if (lobbySignalingRef.current) lobbySignalingRef.current.signal(incomingRequest.from, payload);
      setIncomingRequest(null);
    }
  }, [incomingRequest]);

  const updateNickname = useCallback((newName) => {
    if (lobbySignalingRef.current && identityRef.current) {
      lobbySignalingRef.current.updatePresence({
        displayName: newName,
        os: identityRef.current.os
      });
    }
  }, []);

  // ── Create a room ──
  const createRoom = useCallback(() => {
    const code = generateRoomCode();
    setRoomCode(code);
    _joinRoom(code);
    activityLog.log('info', 'Room created', `Code: ${code}`);
    return code;
  }, [_joinRoom]);

  // ── Join an existing room ──
  const joinRoom = useCallback(async (code) => {
    setRoomCode(code);
    _joinRoom(code);
  }, [_joinRoom]);

  // ── Get the active signaling channel for relay chat ──
  const getSignaling = useCallback(() => {
    return roomSignalingRef.current || lobbySignalingRef.current || null;
  }, []);

  // ── End chat — send goodbye signal, show message, then disconnect ──
  const endChat = useCallback(() => {
    const conn = activeConnectionRef.current;
    // Send a goodbye message over the data channel
    if (conn?.chatChannel?.readyState === 'open') {
      conn.sendChat({ type: 'peer_left', id: crypto.randomUUID(), timestamp: Date.now() });
    }
    // Also send via relay
    const sig = roomSignalingRef.current || lobbySignalingRef.current;
    const id = identityRef.current;
    if (sig && id && connectedPeer) {
      sig.signal(connectedPeer, { type: 'peer_left' });
    }
    // Show system message locally then clear
    import('../chat/messages').then(({ globalMessageStore }) => {
      globalMessageStore.addMessage({
        id: crypto.randomUUID(),
        text: 'You ended the chat.',
        type: 'system',
        senderId: 'system',
        timestamp: Date.now()
      });
    });
    setTimeout(() => {
      if (conn) conn.close();
      activeConnectionRef.current = null;
      setActiveConnection(null);
      setConnectedPeer(null);
      setConnectionTier(null);
      setTransferEngine(null);
    }, 2000);
  }, [connectedPeer]);

  return {
    lanPeers,
    connectToPeer,
    activeConnection,
    connectedPeer,
    connectionTier,
    transferEngine,
    roomCode,
    createRoom,
    joinRoom,
    getSignaling,
    incomingRequest,
    pendingRequest,
    acceptRequest,
    rejectRequest,
    updateNickname,
    endChat
  };
}
