import { onCall, HttpsError } from './runtime';
import { db, FieldValue, getPrivateDiscord, requireAdmin, requireDiscordOn, auditNote } from './admin';
import { webhookDelete, webhookEdit, webhookPost } from './discord';

const LIMIT = 1900; // stay safely under Discord's 2,000 character cap
const isBlockStart = (l: string) => /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|\|)/.test(l.trim());

/** Join soft-wrapped lines inside paragraphs; keep headings, lists, quotes and code intact. */
export function unwrap(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().startsWith('```')) { inCode = !inCode; out.push(line); continue; }
    const prev = out[out.length - 1];
    if (!inCode && line.trim() && prev && prev.trim() && !isBlockStart(line) && !prev.trim().startsWith('#') && !prev.trim().startsWith('```')) {
      out[out.length - 1] = `${prev} ${line.trim()}`;
    } else out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split at headings first, then paragraphs, then hard-wrap — every chunk under LIMIT. */
export function splitForDiscord(md: string): string[] {
  const sections = md.split(/\n(?=#{1,6}\s)/);
  const pieces: string[] = [];
  for (const s of sections) {
    if (s.length <= LIMIT) { pieces.push(s); continue; }
    for (const para of s.split(/\n\n/)) {
      if (para.length <= LIMIT) { pieces.push(para); continue; }
      for (let i = 0; i < para.length; i += LIMIT) pieces.push(para.slice(i, i + LIMIT));
    }
  }
  const chunks: string[] = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 2 + p.length <= LIMIT && !/^#{1,2}\s/.test(p)) chunks[chunks.length - 1] = `${last}\n\n${p}`;
    else chunks.push(p);
  }
  return chunks.map((c) => c.trim()).filter(Boolean);
}

export const publishRules = onCall(async (req) => {
  const uid = requireAdmin(req);
  await requireDiscordOn();
  const priv = await getPrivateDiscord();
  if (!priv.rulesWebhookUrl) throw new HttpsError('failed-precondition', 'Set the rules webhook in Settings → Discord.');
  const ref = db.doc('content/rules');
  const doc = (await ref.get()).data() || {};
  const chunks = splitForDiscord(unwrap(String(doc.markdown || '')));
  const ids: string[] = [...(doc.discordMessageIds || [])];
  const next: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = { content: chunks[i], allowed_mentions: { parse: [] } };
    if (ids[i] && (await webhookEdit(priv.rulesWebhookUrl, ids[i], payload))) { next.push(ids[i]); continue; }
    const m = await webhookPost(priv.rulesWebhookUrl, payload);
    if (m) next.push(m.id);
  }
  for (const extra of ids.slice(chunks.length)) await webhookDelete(priv.rulesWebhookUrl, extra);
  await ref.set({ discordMessageIds: next, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid }, { merge: true });
  await auditNote(uid, `Published rules to Discord (${chunks.length} messages)`, 'content/rules');
  return { messages: next.length, lengths: chunks.map((c) => c.length) };
});
