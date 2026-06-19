async function sha256(str) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function extractLanRoom(pc, onFound) {
  const seen = new Set();
  
  pc.onicecandidate = async ({ candidate }) => {
    if (!candidate) return;
    const sdp = candidate.candidate;
    
    // Only look at host candidates (local network), skip srflx (STUN) and relay (TURN)
    if (sdp.includes('srflx') || sdp.includes('relay')) return;
    
    // Extract IPv4 address
    const ipv4Match = sdp.match(/(\d{1,3}\.){3}\d{1,3}/);
    if (!ipv4Match) return;
    
    const localIP = ipv4Match[0];
    
    // Skip loopback and link-local
    if (localIP.startsWith('127.') || localIP.startsWith('169.254.')) return;
    
    // Extract subnet (first 3 octets = /24 network)
    const subnet = localIP.split('.').slice(0, 3).join('.');
    if (seen.has(subnet)) return;
    seen.add(subnet);
    
    // Hash: 'lan_192.168.1' → deterministic room id for this LAN
    const roomHash = await sha256('lan_' + subnet);
    const lanRoomId = 'lan_' + roomHash.slice(0, 24);
    
    onFound(lanRoomId, localIP, subnet);
  };
}

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0,O,1,I)
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  arr.forEach(b => { code += chars[b % chars.length]; });
  return code;
}

export function generateShareUrl(roomCode, myPeerId) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?room=${roomCode}${myPeerId ? `&peer=${myPeerId}` : ''}`;
}

export function getRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('room') || null;
}

export function getPeerFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('peer') || null;
}

export async function probeLanSubnet(onFound) {
  const dummyPc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  
  dummyPc.createDataChannel('probe');
  
  extractLanRoom(dummyPc, onFound);
  
  const offer = await dummyPc.createOffer();
  await dummyPc.setLocalDescription(offer);
  
  setTimeout(() => dummyPc.close(), 5000);
}
