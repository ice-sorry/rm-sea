/**
 * SEA Rematch League API — Cloudflare Worker (free plan).
 *   POST /api/<op>      callable ops (body: { data }, optional Authorization: Bearer <Firebase ID token>)
 *   POST /interactions  Discord interactions endpoint
 */
import { Firestore } from '../../core/firestore';
import { useDb, configure, useIdentity, useInvoke, HttpsError, CallableRequest } from '../../core/runtime';
import { WORKER_OPS, handleInteraction } from '../../core/index';
import { refreshAttachmentUrl } from '../../core/discord';
import { canonicalDiscordAttachment } from '../../core/shared/league';
import { accessToken, applyClaims, createCustomToken, verifyIdToken, ServiceAccount } from './google';

export interface Env {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_ACCOUNT?: string;   // secret: the service-account JSON key
  FIRESTORE_EMULATOR_HOST?: string;    // local dev only
  FIREBASE_AUTH_EMULATOR_HOST?: string; // local dev only
  ALLOWED_ORIGINS?: string;            // comma-separated; default "*"
  [k: string]: unknown;
}

let ready: Env | null = null;
function init(env: Env) {
  if (ready === env) return;
  ready = env;
  configure(env as Record<string, unknown>);
  const emulator = !!env.FIRESTORE_EMULATOR_HOST;
  const sa: ServiceAccount | null = env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) : null;
  if (!sa && !emulator) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not set.');
  const token = async () => (sa && !emulator ? accessToken(sa) : 'owner'); // "owner" = emulator admin access
  useDb(new Firestore({ projectId: env.FIREBASE_PROJECT_ID, token, emulatorHost: env.FIRESTORE_EMULATOR_HOST }));
  useIdentity({
    applyClaims: (uid, claims, profile) => applyClaims({ projectId: env.FIREBASE_PROJECT_ID, emulatorHost: env.FIREBASE_AUTH_EMULATOR_HOST, token }, uid, claims, profile),
    createCustomToken: (uid) => createCustomToken(emulator ? null : sa, uid),
  });
  // Ops may call other Worker ops (e.g. role sync after a captain accepts a request). The calling op has
  // already authorised the user, so follow-ups run as the system — never with another request's identity.
  useInvoke((op, data) => {
    const h = WORKER_OPS[op];
    if (!h) throw new Error(`Unknown operation ${op}`);
    return h({ data, auth: { uid: 'system', token: { role: 'owner' } } });
  });
}

function cors(env: Env, request: Request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
  };
}

async function runOp(name: string, request: Request, env: Env): Promise<Response> {
  const headers = { ...cors(env, request), 'Content-Type': 'application/json' };
  const send = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  const handler = WORKER_OPS[name];
  if (!handler) return send(404, { error: { code: 'not-found', message: `Unknown operation ${name}.` } });

  let auth: CallableRequest['auth'];
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    const v = await verifyIdToken(bearer, env.FIREBASE_PROJECT_ID, !!env.FIREBASE_AUTH_EMULATOR_HOST);
    if (!v) return send(401, { error: { code: 'unauthenticated', message: 'Your session expired — sign in again.' } });
    auth = { uid: v.uid, token: v.claims };
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { data?: unknown };
    const result = await handler({ data: body.data ?? {}, auth });
    return send(200, { result: result ?? null });
  } catch (e) {
    if (e instanceof HttpsError) return send(e.httpStatus, { error: { code: e.code, message: e.message } });
    console.error(name, e);
    return send(500, { error: { code: 'internal', message: 'Something went wrong — try again.' } });
  }
}

/**
 * GET /discord-image?u=<attachment url>: redirects to a freshly signed Discord CDN link so stored screenshot links
 * keep working after Discord's ~24 h expiry. Cached at the edge for a few hours to stay well within rate limits.
 */
async function discordImage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const src = canonicalDiscordAttachment(new URL(request.url).searchParams.get('u') || '');
  if (!src) return new Response('Not a Discord attachment link', { status: 400 });
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://srl-cache.invalid/discord-image?u=${encodeURIComponent(src)}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const fresh = await refreshAttachmentUrl(String(env.DISCORD_BOT_TOKEN || ''), src);
  const res = new Response(null, { status: 302, headers: { Location: fresh, 'Cache-Control': `public, max-age=${fresh === src ? 60 : 6 * 3600}` } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    init(env);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, request) });
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) return runOp(url.pathname.slice(5), request, env);
    if (request.method === 'POST' && url.pathname === '/interactions') {
      const { response, background } = await handleInteraction(request);
      if (background) ctx.waitUntil(background);
      return response;
    }
    if (request.method === 'GET' && url.pathname === '/discord-image') return discordImage(request, env, ctx);
    if (url.pathname === '/') return new Response('SRL API is running.', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found', { status: 404 });
  },
};
