import { useState, useEffect, useCallback, useRef } from 'react';
import { SignalingChannel, BlazeConnection, getRoomCodeFromUrl, generateRoomCode, isSupabaseConfigured } from '../core';
import { TransferEngine, TIER } from '../transfer/engine';
import { activityLog } from '../utils/activityLog';

export function usePeer(identity) {
  const [lanPeers, setLanPeers] = useState([]);
  const [activeConnection, setActiveConnection] = useState(null);
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

    // Join global lobby for presence / online count
    const lobbySig = new SignalingChannel('global_lobby', identity.peerId);
    lobbySignalingRef.current = lobbySig;

    lobbySig.on('peers', (peers) => {
      setLanPeers(prev => {
        // Merge lobby peers, preserving any WAN-flagged peers from room joins
        const wanIds = new Set(prev.filter(p => p.isWan).map(p => p.id));
        const lobbyPeers = peers.filter(p => !wanIds.has(p.id));
        const wanPeers = prev.filter(p => p.isWan);
        return [...lobbyPeers, ...wanPeers];
      });
      activityLog.setOnlineCount(peers.length + 1);
    });

    // Listen for incoming signals
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

    return () => {
      lobbySignalingRef.current?.disconnect();
      roomSignalingRef.current?.disconnect();
      initedRef.current = false;
    };
  }, [identity?.peerId]);

  // ── Handle incoming P2P connection (responder side) ──
  const _handleIncomingConnection = useCallback((sig, remotePeerId) => {
    const id = identityRef.current;
    if (!id) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, false);

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
      setActiveConnection(null);
      setConnectedPeer(null);
      setConnectionTier(null);
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

    // Use lobby signaling (both peers are already in it)
    let sig = lobbySignalingRef.current;

    // If we have a room, use the room signaling instead
    if (roomSignalingRef.current) {
      sig = roomSignalingRef.current;
    }

    if (!sig) {
      activityLog.log('error', 'No signaling', 'Not connected to any channel');
      return;
    }

    activityLog.log('info', 'Sending request', `To peer: ${remotePeerId.slice(0, 8)}...`);
    setPendingRequest(remotePeerId);
    
    sig.signal(remotePeerId, {
      type: 'chat_request',
      displayName: id.displayName
    });
  }, []);

  const _startInitiatorConnection = useCallback(async (sig, remotePeerId) => {
    const id = identityRef.current;
    if (!id) return;

    const conn = new BlazeConnection(sig, id.peerId, remotePeerId, true);
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
      setActiveConnection(null);
      setConnectedPeer(null);
      setConnectionTier(null);
    });

    await conn.init();

    setActiveConnection(conn);
    setConnectedPeer(remotePeerId);
    setTransferEngine(engine);

    return conn;
  }, []);

  const acceptRequest = useCallback(() => {
    if (!incomingRequest) return;
    const sig = roomSignalingRef.current || lobbySignalingRef.current;
    if (sig) {
      sig.signal(incomingRequest.from, { type: 'chat_accept' });
      _handleIncomingConnection(sig, incomingRequest.from);
    }
    setIncomingRequest(null);
  }, [incomingRequest, _handleIncomingConnection]);

  const rejectRequest = useCallback(() => {
    if (!incomingRequest) return;
    const sig = roomSignalingRef.current || lobbySignalingRef.current;
    if (sig) {
      sig.signal(incomingRequest.from, { type: 'chat_reject' });
    }
    setIncomingRequest(null);
  }, [incomingRequest]);

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
    rejectRequest
  };
}
