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
      const res = await fetch('https://api64.ipify.org?format=json', { 
        signal: AbortSignal.timeout(3000) // 3s timeout, fail fast
      });
      const data = await res.json();
      publicIp = data.ip;
    } catch (ipErr) {
      console.warn('Failed to retrieve public IP, using fallback:', ipErr);
    }

    // For IPv6, collapse to /64 prefix (same as legacy)
    let myIp = publicIp;
    if (myIp.includes(':')) {
      const parts = myIp.split(':');
      if (parts.length > 4) myIp = parts.slice(0, 4).join(':') + '::/64';
    }

    const ipHash = await sha256(myIp);
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
