import { signInWithCustomToken, signOut } from 'firebase/auth';
import { auth, call, USE_EMULATORS } from './firebase';
import { DISCORD_CLIENT_ID } from './config';

const STATE_KEY = 'srl_oauth_state';
export const redirectUri = () => `${location.origin}/auth/callback`;

/** Step 1: redirect to Discord's authorize screen. */
export function startDiscordSignIn() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    response_type: 'code', client_id: DISCORD_CLIENT_ID, scope: 'identify guilds.members.read',
    redirect_uri: redirectUri(), state, prompt: 'none',
  });
  location.href = `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * Steps 2–6: verify state, exchange the code server-side, sign in with the custom token. Returns where to go next.
 * Memoised: React StrictMode runs the callback effect twice, and the second run would find the state already consumed
 * (and the one-time code already spent) and report a bogus "state mismatch" while the first run signs in fine.
 */
let pending: Promise<string> | null = null;
export function completeDiscordSignIn(): Promise<string> {
  return (pending ??= exchangeCallback());
}

async function exchangeCallback(): Promise<string> {
  const p = new URLSearchParams(location.search);
  const code = p.get('code'), state = p.get('state'), err = p.get('error');
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (err) throw new Error(p.get('error_description') || err);
  if (!code || !state || state !== expected) throw new Error('Sign-in state mismatch — please try again.');
  const res = await call<{ code: string; redirectUri: string }, { token: string; playerId: string | null }>('discordAuth')({ code, redirectUri: redirectUri() });
  await signInWithCustomToken(auth, res.token);
  // Has a player → their profile page. No player yet → straight to player setup.
  return res.playerId ? `#player/${encodeURIComponent(res.playerId)}` : '#me';
}

export const signOutUser = () => signOut(auth);

/** Emulator-only: the Auth emulator accepts unsigned custom tokens, so seeded dev accounts can sign in without Discord. */
export async function devSignIn(uid: string, role: 'user' | 'admin' | 'owner') {
  if (!USE_EMULATORS) throw new Error('Dev sign-in is only available against emulators.');
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const now = Math.floor(Date.now() / 1000);
  const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: 'firebase-auth-emulator@example.com', sub: 'firebase-auth-emulator@example.com',
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid, claims: { role },
  })}.`;
  await signInWithCustomToken(auth, token);
}
