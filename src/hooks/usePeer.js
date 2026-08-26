import { useState, useEffect, useCallback, useRef } from 'react';
import { SignalingChannel, BlazeConnection, getRoomCodeFromUrl, getPeerFromUrl, generateRoomCode, isSupabaseConfigured } from '../core';
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
  const [signalingStatus, setSignalingStatus] = useState('disconnected');

  const lobbySignalingRef = useRef(null);
  const roomSignalingRef = useRef(null);
  const identityRef = useRef(null);
  const pendingRequestRef = useRef(null);
  const incomingRequestRef = useRef(null);
  const lanPeersRef = useRef([]);
  const initedRef = useRef(false);
  const messageQueueRef = useRef([]);

  useEffect(() => { identityRef.current = identity; }, [identity]);
  useEffect(() => { pendingRequestRef.current = pendingRequest; }, [pendingRequest]);
  useEffect(() => { incomingRequestRef.current = incomingRequest; }, [incomingRequest]);
  useEffect(() => { lanPeersRef.current = lanPeers; }, [lanPeers]);

  const _flushMessageQueue = useCallback(() => {
    const conn = activeConnectionRef.current;
    if (!conn || !conn.chatChannel || conn.chatChannel.readyState !== 'open') return;
    const queue = messageQueueRef.current.splice(0);
    for (const msg of queue) {
      conn.sendChat(msg);
    }
  }, []);

  const sendMessage = useCallback((message) => {
    const conn = activeConnectionRef.current;
    if (conn?.chatChannel?.readyState === 'open') {
      conn.sendChat(message);
    } else {
      messageQueueRef.current.push(message);
      if (messageQueueRef.current.length > 200) messageQueueRef.current.shift();
    }
  }, []);

  // ── Discovery: join global lobby once ──
  useEffect(() => {
    if (!identity?.peerId || initedRef.current) return;
    initedRef.current = true;

    activityLog.log('info', 'Identity ready', `${identity.displayName} (${identity.os})`);

    if (!isSupabaseConfigured()) {
      setSignalingStatus('not_configured');
      activityLog.log('warn', 'No Supabase', 'Peer discovery disabled — configure .env.local');
      return;
    }

    setSignalingStatus('connecting');

    const initLobby = async () => {
      let networkId = 'discovery_fallback_global';
      try {
        const { getDiscoveryRoomId } = await import('../core/discovery');
        networkId = await getDiscoveryRoomId();
        console.log('Joined discovery room:', networkId.slice(0, 20) + '...');
      } catch (e) {
        console.warn('Discovery room ID failed, using fallback:', e);
      }

      const lobbySig = new SignalingChannel(networkId, identity.peerId);
      lobbySignalingRef.current = lobbySig;

      lobbySig.on('ready', () => setSignalingStatus('connected'));
      lobbySig.on('error', () => setSignalingStatus('error'));
      lobbySig.on('reconnecting', () => setSignalingStatus('reconnecting'));

      lobbySig.on('peers', (peers) => {
        setLanPeers(prev => {
          const wanIds = new Set(prev.filter(p => p.isWan).map(p => p.id));
          const lobbyPeers = peers.filter(p => !wanIds.has(p.id));
          const wanPeers = prev.filter(p => p.isWan);
          return [...lobbyPeers, ...wanPeers];
        });
        activityLog.setOnlineCount(peers.length + 1);

        const conn = activeConnectionRef.current;
        if (conn) {
          const peerPresence = peers.find(p => p.id === conn.remotePeerId);
          if (peerPresence?.displayName) {
            setConnectedPeerName(peerPresence.displayName);
          }
        }
      });

      lobbySig.on('signal', async (payload) => {
        const isLan = true;
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
          const newName = payload.displayName;
          if (newName) {
            setLanPeers(prev => prev.map(p => p.id === payload.from ? { ...p, displayName: newName } : p));
            if (activeConnectionRef.current && activeConnectionRef.current.remotePeerId === payload.from) {
              setConnectedPeerName(newName);
            }
          }
        } else if (payload.type === 'offer' && payload.from) {
          _handleIncomingConnection(lobbySig, payload.from, isLan, payload);
        }
      });

      lobbySig.connect({
        displayName: identity.displayName,
        os: identity.os
      });

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

  const _promoteToAsync = useCallback((engine) => {
    if (!engine || !isSupabaseConfigured()) return false;
    if (engine.currentTier === TIER.ASYNC) return true;
    engine.setTier(TIER.ASYNC);
    setConnectionTier(TIER.ASYNC);
    activityLog.log('fallback', 'WebRTC unreachable → Async mode',
      'Files will transfer via store-and-forward');
    return true;
  }, []);

  const _handleIncomingConnection = useCallback(async (sig, remotePeerId, isLan = false, initialSignal = null) => {
    if (activeConnectionRef.current) return;

    activityLog.log('info', 'Incoming connection', `From ${remotePeerId}`);

    const id = identityRef.current;
    if (!id) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, false);
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

    conn.on('chat_ready', () => {
      _flushMessageQueue();
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
        return;
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
    setConnectedPeerName(incomingRequestRef.current?.displayName || 'Peer');
    setTransferEngine(engine);

    conn.on('chat_message', (msg) => {
      if (msg.type === 'name_change' && msg.displayName) {
        setConnectedPeerName(msg.displayName);
      }
    });
  }, [_promoteToAsync, _flushMessageQueue]);

  const _joinRoom = useCallback((code) => {
    const id = identityRef.current;
    if (!id) return;

    const sig = new SignalingChannel(`room_${code}`, id.peerId);
    roomSignalingRef.current = sig;

    sig.on('ready', () => activityLog.log('success', 'Room signaling connected', `Room: ${code}`));
    sig.on('error', (reason) => activityLog.log('error', 'Room signaling failed', reason));
    sig.on('reconnecting', () => activityLog.log('warn', 'Room reconnecting', 'Attempting to reconnect...'));

    sig.on('peers', (peers) => {
      setLanPeers(prev => {
        const existingIds = new Set(prev.map(p => p.id));
        const newPeers = peers.filter(p => !existingIds.has(p.id));
        return [...prev, ...newPeers.map(p => ({ ...p, isWan: true }))];
      });
    });

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
  }, [_handleIncomingConnection]);

  const connectToPeer = useCallback(async (remotePeerId) => {
    const id = identityRef.current;
    if (!id) return;

    if (!lobbySignalingRef.current && !roomSignalingRef.current) {
      activityLog.log('error', 'No signaling', 'Not connected to any channel');
      return;
    }

    activityLog.log('info', 'Sending request', `To peer: ${remotePeerId.slice(0, 8)}...`);
    setPendingRequest(remotePeerId);

    setTimeout(() => {
      if (pendingRequestRef.current === remotePeerId) {
        setPendingRequest(null);
        activityLog.log('error', 'Request timeout', 'Peer did not respond in time');
      }
    }, 15000);

    const payload = { type: 'chat_request', displayName: id.displayName };
    if (roomSignalingRef.current) roomSignalingRef.current.signal(remotePeerId, payload);
    if (lobbySignalingRef.current) lobbySignalingRef.current.signal(remotePeerId, payload);
  }, []);

  const _startInitiatorConnection = useCallback(async (sig, remotePeerId, isLan = false) => {
    const id = identityRef.current;
    if (!id) return;

    if (activeConnectionRef.current) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, true);
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

    conn.on('chat_ready', () => {
      _flushMessageQueue();
    });

    conn.on('ice_timeout', () => {
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
        return;
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
    setConnectedPeerName(lanPeersRef.current.find(p => p.id === remotePeerId)?.displayName || 'Peer');
    setTransferEngine(engine);

    conn.on('chat_message', (msg) => {
      if (msg.type === 'name_change' && msg.displayName) {
        setConnectedPeerName(msg.displayName);
      }
    });

    return conn;
  }, [_promoteToAsync, _flushMessageQueue]);

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

    const presencePayload = { displayName: newName, os: id.os };
    if (lobbySignalingRef.current) lobbySignalingRef.current.updatePresence(presencePayload);
    if (roomSignalingRef.current) roomSignalingRef.current.updatePresence(presencePayload);

    const nameChangePayload = { type: 'name_change', displayName: newName, from: id.peerId };

    if (lobbySignalingRef.current) {
      lobbySignalingRef.current.send('signal', nameChangePayload);
    }
    if (roomSignalingRef.current) {
      roomSignalingRef.current.send('signal', nameChangePayload);
    }

    const conn = activeConnectionRef.current;
    if (conn?.chatChannel?.readyState === 'open') {
      conn.sendChat({ ...nameChangePayload, id: crypto.randomUUID(), timestamp: Date.now() });
    }
  }, [connectedPeer]);

  const createRoom = useCallback(() => {
    const code = generateRoomCode();
    setRoomCode(code);
    _joinRoom(code);
    activityLog.log('info', 'Room created', `Code: ${code}`);
    return code;
  }, [_joinRoom]);

  const joinRoom = useCallback(async (code) => {
    setRoomCode(code);
    _joinRoom(code);
  }, [_joinRoom]);

  const getSignaling = useCallback(() => {
    return roomSignalingRef.current || lobbySignalingRef.current || null;
  }, []);

  const endChat = useCallback(() => {
    const conn = activeConnectionRef.current;
    if (conn?.chatChannel?.readyState === 'open') {
      conn.sendChat({ type: 'peer_left', id: crypto.randomUUID(), timestamp: Date.now() });
    }
    const sig = roomSignalingRef.current || lobbySignalingRef.current;
    const id = identityRef.current;
    if (sig && id && connectedPeer) {
      sig.signal(connectedPeer, { type: 'peer_left' });
    }
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
    endChat,
    signalingStatus,
    sendMessage
  };
}
