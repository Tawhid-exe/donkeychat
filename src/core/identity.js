const ADJECTIVES = [
  'Swift', 'Bold', 'Calm', 'Dark', 'Fast', 'Gold', 'Hard', 'Iron',
  'Jade', 'Keen', 'Lone', 'Mist', 'Neon', 'Onyx', 'Pure', 'Quiet',
  'Rust', 'Salt', 'Teal', 'Vast', 'Wild', 'Zinc'
];
const ANIMALS = [
  'Falcon', 'Jaguar', 'Cobra', 'Hyena', 'Raven', 'Viper', 'Moose',
  'Crane', 'Bison', 'Lynx', 'Otter', 'Badger', 'Dingo', 'Gecko',
  'Heron', 'Ibis', 'Kite', 'Lark', 'Manta', 'Newt'
];

function generateDisplayName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = String(Math.floor(1000 + Math.random() * 9000));
  return `${adj}${animal}-${num}`;
}

async function generateKeypair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
}

export async function initIdentity() {
  const stored = localStorage.getItem('blaze_identity');
  if (stored) {
    const parsed = JSON.parse(stored);
    const publicKey = await crypto.subtle.importKey(
      'jwk', parsed.publicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, []
    );
    const privateKey = await crypto.subtle.importKey(
      'jwk', parsed.privateKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    return {
      peerId: parsed.peerId,
      displayName: parsed.displayName,
      publicKey,
      privateKey,
      publicKeyJwk: parsed.publicKeyJwk
    };
  }

  const keypair = await generateKeypair();
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keypair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey);

  const peerId = btoa(publicKeyJwk.x).slice(0, 16).replace(/[+/=]/g, '0');
  const displayName = generateDisplayName();

  const identity = { peerId, displayName, publicKeyJwk, privateKeyJwk };
  localStorage.setItem('blaze_identity', JSON.stringify(identity));

  return {
    peerId,
    displayName,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyJwk
  };
}

export function getOS() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android';
  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (/Win/.test(ua)) return 'Windows';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}
