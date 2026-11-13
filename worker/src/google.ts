/** Google/Firebase auth in plain WebCrypto: service-account tokens, custom tokens, ID-token verification, user claims. */

export interface ServiceAccount { client_email: string; private_key: string; project_id?: string }

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  let s = '';
  new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
};
const b64urlJson = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const keyCache = new Map<string, Promise<CryptoKey>>();
function signingKey(pem: string) {
  if (!keyCache.has(pem)) {
    const der = fromB64url(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
    keyCache.set(pem, crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']));
  }
  return keyCache.get(pem)!;
}
async function signJwt(sa: ServiceAccount, payload: Record<string, unknown>) {
  const head = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa.private_key), enc.encode(head));
  return `${head}.${b64url(sig)}`;
}

// ---------- OAuth access token for Firestore / Identity Toolkit ----------
let cached: { token: string; exp: number } | null = null;
export async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;
  const assertion = await signJwt(sa, {
    iss: sa.client_email, sub: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Service account token failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: now + j.expires_in };
  return j.access_token;
}

// ---------- Custom tokens ----------
const TOOLKIT_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
export async function createCustomToken(sa: ServiceAccount | null, uid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!sa) {
    // Auth emulator accepts unsigned tokens.
    return `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson({ iss: 'firebase-auth-emulator@example.com', sub: 'firebase-auth-emulator@example.com', aud: TOOLKIT_AUD, iat: now, exp: now + 3600, uid })}.`;
  }
  return signJwt(sa, { iss: sa.client_email, sub: sa.client_email, aud: TOOLKIT_AUD, iat: now, exp: now + 3600, uid });
}

// ---------- ID token verification ----------
let jwks: { keys: Map<string, Promise<CryptoKey>>; exp: number } | null = null;
async function publicKey(kid: string): Promise<CryptoKey | null> {
  if (!jwks || jwks.exp < Date.now()) {
    const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    const maxAge = Number(res.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 3600);
    const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    jwks = {
      exp: Date.now() + maxAge * 1000,
      keys: new Map(body.keys.map((k) => [k.kid, crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])])),
    };
  }
  return (await jwks.keys.get(kid)) ?? null;
}

export interface VerifiedToken { uid: string; claims: Record<string, unknown> }
export async function verifyIdToken(token: string, projectId: string, emulator: boolean): Promise<VerifiedToken | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0]))) as { alg: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as Record<string, any>;
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp < now || !claims.sub) return null;
    if (!emulator) {
      if (header.alg !== 'RS256' || !header.kid) return null;
      const key = await publicKey(header.kid);
      if (!key) return null;
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
      if (!ok) return null;
    }
    return { uid: claims.sub as string, claims };
  } catch {
    return null;
  }
}

// ---------- Users & custom claims (Identity Toolkit REST) ----------
export async function applyClaims(
  opts: { projectId: string; emulatorHost?: string; token: () => Promise<string> },
  uid: string, claims: Record<string, unknown>, profile?: { displayName?: string; photoURL?: string },
) {
  const base = opts.emulatorHost
    ? `http://${opts.emulatorHost}/identitytoolkit.googleapis.com/v1/projects/${opts.projectId}`
    : `https://identitytoolkit.googleapis.com/v1/projects/${opts.projectId}`;
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await opts.token()}` }, body: JSON.stringify(body),
    });
    return { ok: res.ok, text: res.ok ? '' : await res.text() };
  };
  let r = await call('/accounts:update', { localId: uid, customAttributes: JSON.stringify(claims) });
  if (!r.ok && /USER_NOT_FOUND/.test(r.text)) {
    const c = await call('/accounts', { localId: uid, displayName: profile?.displayName, photoUrl: profile?.photoURL });
    if (!c.ok && !/DUPLICATE_LOCAL_ID/.test(c.text)) throw new Error(`Create user failed: ${c.text}`);
    r = await call('/accounts:update', { localId: uid, customAttributes: JSON.stringify(claims) });
  }
  if (!r.ok) throw new Error(`Set claims failed: ${r.text}`);
}
