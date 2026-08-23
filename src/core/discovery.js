/**
 * Discovery module — matches the legacy approach exactly.
 * Uses ipify.org public IP API to group peers on the same network.
 * This is instant and reliable, unlike ICE candidate gathering which
 * is blocked by mDNS in modern browsers.
 */

async function sha256(str) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Get a deterministic discovery room ID based on the user's public IP.
 * All devices behind the same router will share the same public IP,
 * so they will join the same discovery channel — exactly like the legacy version.
 *
 * Returns: Promise<string> — e.g. "discovery_a1b2c3d4e5..."
 */
export async function getDiscoveryRoomId() {
  try {
    let publicIp = 'fallback-ip';
    
    try {
      // Use IPv4-only endpoint so all devices on same router get same IP
      // (api64 can return IPv6 on some devices, IPv4 on others → different hashes)
      const res = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(4000)
      });
      const data = await res.json();
      publicIp = data.ip;
    } catch {
      try {
        // Secondary fallback — try the dual-stack endpoint
        const res = await fetch('https://api64.ipify.org?format=json', { 
          signal: AbortSignal.timeout(3000)
        });
        const data = await res.json();
        publicIp = data.ip;
        // Normalize IPv6 to /64 prefix so devices on same network share a room
        if (publicIp.includes(':')) {
          const parts = publicIp.split(':');
          if (parts.length > 4) publicIp = parts.slice(0, 4).join(':') + '::/64';
        }
      } catch {
        console.warn('Both IP endpoints failed, using fallback channel');
      }
    }

    const ipHash = await sha256(publicIp);
    return 'discovery_' + ipHash;
  } catch (e) {
    console.error('Discovery setup failed:', e);
    return 'discovery_fallback_global';
  }
}

export function getRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('room') || null;
}

export function getPeerFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('peer') || null;
}

/** Generate a random 6-digit numeric room code */
export function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Build a shareable URL for a room (and optionally a specific peer).
 * e.g. https://donkeychat.pages.dev/?room=123456&peer=abc123
 */
export function generateShareUrl(roomCode, peerId = null) {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  if (peerId) url.searchParams.set('peer', peerId);
  return url.toString();
}
