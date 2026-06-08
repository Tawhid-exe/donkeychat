import { useState, useEffect, useCallback, useRef } from 'react';
import { probeLanSubnet, SignalingChannel, BlazeConnection, getRoomCodeFromUrl, generateRoomCode, isSupabaseConfigured } from '../core';
import { TransferEngine, TIER } from '../transfer/engine';
import { activityLog } from '../utils/activityLog';

export function usePeer(identity) {
  const [lanPeers, setLanPeers] = useState([]);
  const [activeConnection, setActiveConnection] = useState(null);
  const [connectedPeer, setConnectedPeer] = useState(null);
  const [connectionTier, setConnectionTier] = useState(null);
  const [transferEngine, setTransferEngine] = useState(null);
  const [roomCode, setRoomCode] = useState(null);

  // FIX #1: Store the LAN room signaling channel for reuse
  const lanSignalingRef = useRef(null);
  const lanRoomIdRef = useRef(null);

  useEffect(() => {
    if (!identity?.peerId) return;

    activityLog.log('info', 'Identity ready', `${identity.displayName} (${identity.os})`);

    if (!isSupabaseConfigured()) {
      activityLog.log('warn', 'No Supabase', 'Peer discovery disabled — configure .env.local');
      return;
    }

    // Check URL for room code (WAN invite link)
    const urlRoom = getRoomCodeFromUrl();
    if (urlRoom) {
      setRoomCode(urlRoom);
      activityLog.log('info', 'Room code from URL', urlRoom);
      _joinRoom(urlRoom, identity);
    }

    // Start global discovery lobby
    activityLog.log('info', 'Discovery started', 'Joining global peer lobby...');
    const sig = new SignalingChannel('global_lobby', identity.peerId);
    lanSignalingRef.current = sig;

    sig.on('peers', (peers) => {
      setLanPeers(peers);
      // Update online count
      activityLog.setOnlineCount(peers.length + 1); // +1 for self
    });

    sig.connect({
      displayName: identity.displayName,
      os: identity.os,
      localIP: 'global'
    });

    return () => {
      lanSignalingRef.current?.disconnect();
    };
  }, [identity?.peerId]);

  // Join a specific room (for WAN connections via room code)
  const _joinRoom = useCallback(async (code, id) => {
    const sig = new SignalingChannel(`room_${code}`, id.peerId);
    sig.on('peers', (peers) => {
      // Merge WAN peers with LAN peers (deduplicate by id)
      setLanPeers(prev => {
        const ids = new Set(prev.map(p => p.id));
        const newPeers = peers.filter(p => !ids.has(p.id));
        return [...prev, ...newPeers.map(p => ({ ...p, isWan: true }))];
      });
    });
    await sig.connect({
      displayName: id.displayName,
      os: id.os
    });
    activityLog.log('success', 'WAN room joined', `Room: ${code}`);
    return sig;
  }, []);

  // FIX #1: connectToPeer now uses the SAME signaling room the peer is already in
  const connectToPeer = useCallback(async (remotePeerId, isLan = false) => {
    if (!identity) return;

    // Use the LAN room signaling if it's a LAN peer
    // This fixes the "wrong room" bug — we reuse the room both peers are in
    let sig;
    if (isLan && lanSignalingRef.current) {
      sig = lanSignalingRef.current;
      activityLog.log('info', 'Connecting via LAN', `To peer: ${remotePeerId.slice(0, 8)}...`);
    } else {
      // For WAN, create a new signaling channel with the room code
      const code = roomCode || generateRoomCode();
      if (!roomCode) setRoomCode(code);
      sig = new SignalingChannel(`room_${code}`, identity.peerId);
      await sig.connect({ displayName: identity.displayName, os: identity.os });
      activityLog.log('info', 'Connecting via WAN', `Room: ${code}, Peer: ${remotePeerId.slice(0, 8)}...`);
    }

    const conn = new BlazeConnection(sig, identity.peerId, remotePeerId, true);
    conn.expectedTier = isLan ? 'lan' : 'wan';

    const engine = new TransferEngine(conn, identity);

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
      activityLog.log('fallback', 'LAN failed → WAN/TURN', 'AP Isolation detected, falling back...');
    });

    conn.on('ice_timeout', () => {
      activityLog.log('error', 'WebRTC timeout', 'All ICE candidates failed');
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
  }, [identity, roomCode]);

  // Create a room code for sharing
  const createRoom = useCallback(() => {
    const code = generateRoomCode();
    setRoomCode(code);
    if (identity) {
      _joinRoom(code, identity);
    }
    activityLog.log('info', 'Room created', `Code: ${code}`);
    return code;
  }, [identity, _joinRoom]);

  // Join an existing room by code
  const joinRoom = useCallback(async (code) => {
    setRoomCode(code);
    if (identity) {
      await _joinRoom(code, identity);
    }
  }, [identity, _joinRoom]);

  return {
    lanPeers,
    connectToPeer,
    activeConnection,
    connectedPeer,
    connectionTier,
    transferEngine,
    roomCode,
    createRoom,
    joinRoom
  };
}
