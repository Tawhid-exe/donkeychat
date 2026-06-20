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
  const seenSubnet = new Set();
  const seenPublic = new Set();
  let foundSubnet = false;
  
  pc.onicecandidate = async ({ candidate }) => {
    if (!candidate) return;
    const sdp = candidate.candidate;
    
    // Extract IPv4 address
    const ipv4Match = sdp.match(/(\d{1,3}\.){3}\d{1,3}/);
    if (!ipv4Match) return;
    const ip = ipv4Match[0];
    
    // Skip loopback and link-local
    if (ip.startsWith('127.') || ip.startsWith('169.254.')) return;

    if (sdp.includes('host')) {
      // Local network
      const subnet = ip.split('.').slice(0, 3).join('.');
      if (seenSubnet.has(subnet)) return;
      seenSubnet.add(subnet);
      
      const roomHash = await sha256('lan_' + subnet);
      foundSubnet = true;
      onFound('lan_' + roomHash.slice(0, 24), 'lan');
    } else if (sdp.includes('srflx')) {
      // Public IP (behind NAT)
      if (seenPublic.has(ip) || foundSubnet) return;
      seenPublic.add(ip);
      
      const roomHash = await sha256('wan_' + ip);
      onFound('wan_' + roomHash.slice(0, 24), 'wan');
    }
  };
}

export function generateRoomCode() {
  // Pure numeric 6-digit code: 000000 – 999999
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b % 10).join('');
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
