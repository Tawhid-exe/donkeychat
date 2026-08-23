import { useState, useEffect, useCallback, useRef } from 'react';
import { createSignalingChannel, BlazeConnection, getRoomCodeFromUrl, getPeerFromUrl, generateRoomCode, isTransportConfigured } from '../core';
import { TransferEngine, TIER } from '../transfer/engine';
import { activityLog } from '../utils/activityLog';

export function usePeer(identity) {
  const [lanPeers, setLanPeers] = useState([]);
  const [activeConnection, setActiveConnection] = useState(null);
  const activeConnectionRef = useRef(null);
  const [connectedPeer, setConnectedPeer] = useState(null);
  const [connectedPeerName, setConnectedPeerName] = useState('Peer');
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
  const incomingRequestRef = useRef(null);
  const lanPeersRef = useRef([]);
  const initedRef = useRef(false);

  // Keep refs in sync
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    pendingRequestRef.current = pendingRequest;
  }, [pendingRequest]);
  useEffect(() => {
    incomingRequestRef.current = incomingRequest;
  }, [incomingRequest]);
  useEffect(() => {
    lanPeersRef.current = lanPeers;
  }, [lanPeers]);

  // ── Discovery: join global lobby once ──
  useEffect(() => {
    if (!identity?.peerId || initedRef.current) return;
    initedRef.current = true;

    activityLog.log('info', 'Identity ready', `${identity.displayName} (${identity.os})`);

    if (!isTransportConfigured()) {
      activityLog.log('warn', 'No backend', 'Peer discovery disabled — configure Supabase or VITE_RELAY_WS_URL');
      return;
    }

    const initLobby = async () => {
      // Legacy approach: use public IP API for instant, reliable discovery
      let networkId = 'discovery_fallback_global';
      try {
        const { getDiscoveryRoomId } = await import('../core/discovery');
        networkId = await getDiscoveryRoomId();
        console.log('Joined discovery room:', networkId.slice(0, 20) + '...');
      } catch (e) {
        console.warn('Discovery room ID failed, using fallback:', e);
      }

      // Join network-specific lobby for presence / online count
      const lobbySig = createSignalingChannel(networkId, identity.peerId);
      lobbySignalingRef.current = lobbySig;

      // Presence sync — handles peer list AND real-time name changes automatically
      // (This is how the legacy version worked — no separate name_change signals needed)
      lobbySig.on('peers', (peers) => {
        setLanPeers(prev => {
          const wanIds = new Set(prev.filter(p => p.isWan).map(p => p.id));
          const lobbyPeers = peers.filter(p => !wanIds.has(p.id));
          const wanPeers = prev.filter(p => p.isWan);
          return [...lobbyPeers, ...wanPeers];
        });
        activityLog.setOnlineCount(peers.length + 1);

        // Also update connected peer name from presence if they changed it
        const conn = activeConnectionRef.current;
        if (conn) {
          const peerPresence = peers.find(p => p.id === conn.remotePeerId);
          if (peerPresence?.displayName) {
            setConnectedPeerName(peerPresence.displayName);
          }
        }
      });

      lobbySig.on('signal', async (payload) => {
        const isLan = true; // same public IP = same network
        if (payload.type === 'chat_request' && payload.from) {
          setIncomingRequest({ from: payload.from, displayName: payload.displayName || 'Peer', isLan });
        } else if (payload.type === 'chat_accept' && payload.from) {
          if (pendingRequestRef.current === payload.from) {
            setPendingRequest(null);
            _startInitiatorConnection(lobbySig, payload.from, isLan);
          }
        } else if (payload.type === 'chat_reject' && payload.from) {
          if (pendingRequestRef.current === payload.from) {
            setPendingRequest(null);
            activityLog.log('error', 'Connection rejected', 'User denied the chat request');
          }
        } else if (payload.type === 'name_change' && payload.from) {
          // Backup: handle name_change broadcasts (WebRTC data channel relays these)
          const newName = payload.displayName;
          if (newName) {
            setLanPeers(prev => prev.map(p => p.id === payload.from ? { ...p, displayName: newName } : p));
            if (activeConnectionRef.current && activeConnectionRef.current.remotePeerId === payload.from) {
              setConnectedPeerName(newName);
            }
          }
      } else if (payload.type === 'offer' && payload.from) {
        // Pass the SDP payload through — it arrived before the connection's
        // own signal listener existed and would otherwise be dropped.
        _handleIncomingConnection(lobbySig, payload.from, isLan, payload);
      }
    });

    lobbySig.connect({
        displayName: identity.displayName,
        os: identity.os
      });

      // Check URL for room code + optional peer (from Copy Link)
      const urlRoom = getRoomCodeFromUrl();
      const urlPeer = getPeerFromUrl();
      if (urlRoom) {
        setRoomCode(urlRoom);
        activityLog.log('info', 'Room code from URL', urlRoom);
        _joinRoom(urlRoom);
        if (urlPeer) {
          setTimeout(() => {
            activityLog.log('info', 'Auto-connecting via link', urlPeer.slice(0, 8) + '...');
            setPendingRequest(urlPeer);
            const payload = { type: 'chat_request', displayName: identityRef.current?.displayName };
            if (roomSignalingRef.current) roomSignalingRef.current.signal(urlPeer, payload);
            if (lobbySignalingRef.current) lobbySignalingRef.current.signal(urlPeer, payload);
          }, 2000);
        }
      }
    };

    initLobby();

    return () => {
      if (lobbySignalingRef.current) lobbySignalingRef.current.disconnect();
      if (roomSignalingRef.current) roomSignalingRef.current.disconnect();
      initedRef.current = false;
    };
  }, [identity?.peerId]);

  // ── Tier 4 promotion: WebRTC dead, but a chunk store is reachable ──
  const _promoteToAsync = useCallback((engine) => {
    if (!engine || !isTransportConfigured()) return false;
    if (engine.currentTier === TIER.ASYNC) return true;
    engine.setTier(TIER.ASYNC);
    setConnectionTier(TIER.ASYNC);
    activityLog.log('fallback', 'WebRTC unreachable → Async mode',
      'Files will transfer via store-and-forward');
    return true;
  }, []);

  // ── Handle incoming P2P connection (responder side) ──
  const _handleIncomingConnection = useCallback(async (sig, remotePeerId, isLan = false, initialSignal = null) => {
    if (activeConnectionRef.current) return;
    
    activityLog.log('info', 'Incoming connection', `From ${remotePeerId}`);

    const id = identityRef.current;
    if (!id) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, false);
    // Flag LAN-expected so AP Isolation fast failover activates
    conn.expectedTier = isLan ? 'lan' : null;
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

    conn.on('ice_timeout', () => {
      _promoteToAsync(engine);
    });

    conn.on('failed', () => {
      if (_promoteToAsync(engine)) {
        import('../chat/messages').then(({ globalMessageStore }) => {
          globalMessageStore.addMessage({
            id: crypto.randomUUID(),
            text: 'Direct P2P failed — switched to async transfer mode. Chat continues via relay.',
            type: 'system',
            senderId: 'system',
            timestamp: Date.now()
          });
        });
        return; // keep the shell connection alive for relayed chat/transfers
      }
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
        setConnectedPeerName('Peer');
        setConnectionTier(null);
      }, 3000);
    });

    conn.init(initialSignal);

    setActiveConnection(conn);
    setConnectedPeer(remotePeerId);
    // Use ref to get current displayName (avoids stale closure issue)
    setConnectedPeerName(incomingRequestRef.current?.displayName || 'Peer');
    setTransferEngine(engine);

    // Also handle name_change coming through WebRTC data channel
    conn.on('chat_message', (msg) => {
      if (msg.type === 'name_change' && msg.displayName) {
        setConnectedPeerName(msg.displayName);
      }
    });
  }, [_promoteToAsync]);

  // ── Join a room by code ──
  const _joinRoom = useCallback((code) => {
    const id = identityRef.current;
    if (!id) return;

    const sig = createSignalingChannel(`room_${code}`, id.peerId);
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
      } else if (payload.type === 'name_change' && payload.from) {
        const newName = payload.displayName;
        if (newName) {
          setLanPeers(prev => prev.map(p => p.id === payload.from ? { ...p, displayName: newName } : p));
          if (activeConnectionRef.current) setConnectedPeerName(newName);
        }
      } else if (payload.type === 'offer' && payload.from) {
        _handleIncomingConnection(sig, payload.from, false, payload);
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
    
    // Set a timeout to clear the pending request if ignored
    setTimeout(() => {
      if (pendingRequestRef.current === remotePeerId) {
        setPendingRequest(null);
        activityLog.log('error', 'Request timeout', 'Peer did not respond in time');
      }
    }, 15000);
    
    // Send on all available channels to ensure delivery
    const payload = { type: 'chat_request', displayName: id.displayName };
    if (roomSignalingRef.current) roomSignalingRef.current.signal(remotePeerId, payload);
    if (lobbySignalingRef.current) lobbySignalingRef.current.signal(remotePeerId, payload);
  }, []);

  const _startInitiatorConnection = useCallback(async (sig, remotePeerId, isLan = false) => {
    const id = identityRef.current;
    if (!id) return;

    if (activeConnectionRef.current) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, true);
    // Flag LAN-expected so AP Isolation fast failover activates
    conn.expectedTier = isLan ? 'lan' : null;
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
      // WebRTC exhausted all candidates — promote to Tier 4 (async
      // store-and-forward) so files still flow over Supabase Storage.
      if (_promoteToAsync(engine)) {
        activityLog.log('info', 'Chat continues via relay', 'Encrypted through E2E session key');
      } else {
        activityLog.log('error', 'WebRTC timeout', 'All ICE candidates failed — using relay chat');
      }
    });

    conn.on('failed', () => {
      if (_promoteToAsync(engine)) {
        import('../chat/messages').then(({ globalMessageStore }) => {
          globalMessageStore.addMessage({
            id: crypto.randomUUID(),
            text: 'Direct P2P failed — switched to async transfer mode. Chat continues via relay.',
            type: 'system',
            senderId: 'system',
            timestamp: Date.now()
          });
        });
        return; // keep the shell connection alive for relayed chat/transfers
      }
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
        setConnectedPeerName('Peer');
        setConnectionTier(null);
      }, 3000);
    });

    await conn.init();

    setActiveConnection(conn);
    setConnectedPeer(remotePeerId);
    // Resolve initial peer name from lanPeers (via ref to avoid stale closure)
    setConnectedPeerName(lanPeersRef.current.find(p => p.id === remotePeerId)?.displayName || 'Peer');
    setTransferEngine(engine);

    // Handle name_change coming through WebRTC data channel
    conn.on('chat_message', (msg) => {
      if (msg.type === 'name_change' && msg.displayName) {
        setConnectedPeerName(msg.displayName);
      }
    });

    return conn;
  }, [_promoteToAsync]);

  const acceptRequest = useCallback(() => {
    if (!incomingRequest) return;
    const payload = { type: 'chat_accept' };
    const isLan = !!incomingRequest.isLan;
    
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
      _handleIncomingConnection(activeSig, incomingRequest.from, isLan);
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
    const id = identityRef.current;
    if (!id) return;
    
    // Update local state and storage
    id.displayName = newName;
    const storedStr = localStorage.getItem('blaze_identity');
    if (storedStr) {
      try {
        const stored = JSON.parse(storedStr);
        stored.displayName = newName;
        localStorage.setItem('blaze_identity', JSON.stringify(stored));
      } catch {
        // Corrupted stored identity — leave it as-is
      }
    }

    // Update presence so peer list shows the new name (primary sync)
    const presencePayload = { displayName: newName, os: id.os };
    if (lobbySignalingRef.current) lobbySignalingRef.current.updatePresence(presencePayload);
    if (roomSignalingRef.current) roomSignalingRef.current.updatePresence(presencePayload);

    // Broadcast name change signal explicitly (fallback/immediate sync)
    const nameChangePayload = { type: 'name_change', displayName: newName, from: id.peerId };
    
    if (lobbySignalingRef.current) {
      lobbySignalingRef.current.send('signal', nameChangePayload);
    }
    if (roomSignalingRef.current) {
      roomSignalingRef.current.send('signal', nameChangePayload);
    }

    // Also send over WebRTC data channel (fastest) if actively connected
    const conn = activeConnectionRef.current;
    if (conn?.chatChannel?.readyState === 'open') {
      conn.sendChat({ ...nameChangePayload, id: crypto.randomUUID(), timestamp: Date.now() });
    }
  }, [connectedPeer]);

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
      setConnectedPeerName('Peer');
      setConnectionTier(null);
      setTransferEngine(null);
    }, 2000);
  }, [connectedPeer]);

  return {
    lanPeers,
    connectToPeer,
    activeConnection,
    connectedPeer,
    connectedPeerName,
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
