import { logger } from './runtime';

const API = 'https://discord.com/api/v10';

/** Bot-authenticated Discord REST call with basic 429 retry. */
export async function discordApi<T = unknown>(token: string, method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not configured.');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 2) {
    const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
    await new Promise((r) => setTimeout(r, Math.ceil((j.retry_after ?? 1) * 1000)));
    return discordApi<T>(token, method, path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    logger.warn('Discord API error', { method, path, status: res.status, text });
    throw new Error(`Discord ${method} ${path} failed: ${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Direct message a Discord user from the bot. Throws when it can't be delivered (the user blocks DMs from
 * server members, has left the server, or the bot token is missing); callers treat DMs as best-effort.
 */
export async function sendDm(token: string, userId: string, message: unknown): Promise<void> {
  const channel = await discordApi<{ id: string }>(token, 'POST', '/users/@me/channels', { recipient_id: userId });
  await discordApi(token, 'POST', `/channels/${channel.id}/messages`, message);
}

/** Webhook helpers. URL form: https://discord.com/api/webhooks/{id}/{token} */
export async function webhookPost(url: string, payload: unknown): Promise<{ id: string } | null> {
  if (!url) return null;
  const res = await fetch(`${url}?wait=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { logger.warn('webhook post failed', { status: res.status, text: await res.text() }); return null; }
  return (await res.json()) as { id: string };
}
export async function webhookEdit(url: string, messageId: string, payload: unknown): Promise<boolean> {
  const res = await fetch(`${url}/messages/${messageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return res.ok;
}
export async function webhookDelete(url: string, messageId: string): Promise<void> {
  await fetch(`${url}/messages/${messageId}`, { method: 'DELETE' }).catch(() => undefined);
}

const hexBytes = (hex: string) => new Uint8Array((hex.match(/.{1,2}/g) || []).map((b) => parseInt(b, 16)));

/** Ed25519 verification for the interactions endpoint (WebCrypto). */
export async function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, rawBody: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', hexBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexBytes(signatureHex), new TextEncoder().encode(timestamp + rawBody));
  } catch {
    return false;
  }
}

export const avatarUrl = (id: string, hash: string | null | undefined) =>
  hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;

/** Fresh signed URL for a Discord attachment (POST /attachments/refresh-urls). Falls back to the input on failure. */
export async function refreshAttachmentUrl(token: string, url: string): Promise<string> {
  try {
    const r = await discordApi<{ refreshed_urls: { original: string; refreshed: string }[] }>(token, 'POST', '/attachments/refresh-urls', { attachment_urls: [url] });
    return r.refreshed_urls?.[0]?.refreshed || url;
  } catch (e) {
    logger.warn('attachment refresh failed', e);
    return url;
  }
}
