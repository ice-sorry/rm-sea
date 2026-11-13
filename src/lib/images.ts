import { API_URL } from './firebase';
import { canonicalDiscordAttachment } from './types';

/** Normalise a pasted screenshot link: Discord attachments are stored without their expiring signature. */
export function normalizeImageLink(raw: string): string {
  const url = raw.trim();
  if (!/^https:\/\/\S+$/.test(url)) throw new Error('Paste an https:// image link.');
  return canonicalDiscordAttachment(url) || url;
}

/** URL to put in <img src>: Discord attachments go through the Worker, which re-signs them so they never expire. */
export function imageSrc(url: string): string {
  const d = canonicalDiscordAttachment(url);
  return d && API_URL ? `${API_URL}/discord-image?u=${encodeURIComponent(d)}` : url;
}
