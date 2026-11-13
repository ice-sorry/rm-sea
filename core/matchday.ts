import { onCall, HttpsError, logger } from './runtime';
import { db, FieldValue, Timestamp, getSettings, requireAdmin, requireAuth, roleOf, currentSeasonId, DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } from './admin';
import { discordApi, verifyDiscordSignature } from './discord';
import { Match, StandingRow } from './shared/league';

async function names(): Promise<Record<string, Record<string, any>>> {
  const t = await db.collection('teams').get();
  return Object.fromEntries(t.docs.map((d) => [d.id, d.data()!]));
}

// Paging keeps each Worker invocation under the free plan's 50-subrequest cap; the browser calls again until done.
const THREADS_PER_CALL = 12; // 2 Discord calls each
const RENAMES_PER_CALL = 30;

// ---------- Matchweek threads ----------
export const publishMatchweek = onCall(async (req) => {
  const uid = requireAdmin(req);
  const { seasonId, weekNo } = req.data as { seasonId: string; weekNo: number };
  const integ = await getSettings<{ matchReportChannelId?: string }>('integrations');
  if (!integ.matchReportChannelId) throw new HttpsError('failed-precondition', 'Set the match report channel in Settings → Discord.');
  const token = DISCORD_BOT_TOKEN.value();
  const teams = await names();
  const ms = (await db.collection(`seasons/${seasonId}/matches`).where('matchweek', '==', Number(weekNo)).get()).docs
    .map((d) => ({ ref: d.ref, m: { id: d.id, ...d.data() } as Match })).filter(({ m }) => m.stage === 'league');
  const todo = ms.filter(({ m }) => !m.discordThreadId);
  const page = todo.slice(0, THREADS_PER_CALL);
  const threadIds: Record<string, string> = Object.fromEntries(ms.filter(({ m }) => m.discordThreadId).map(({ m }) => [m.id, m.discordThreadId!]));
  const batch = db.batch();
  for (const { ref, m } of page) {
    const h = teams[m.homeTeamId] || {}, a = teams[m.awayTeamId] || {};
    const name = `R${m.round} · ${h.name || 'Home'} vs ${a.name || 'Away'}`.slice(0, 100);
    const thread = await discordApi<{ id: string }>(token, 'POST', `/channels/${integ.matchReportChannelId}/threads`, { name, type: 11, auto_archive_duration: 10080 });
    const pings = [h.discordRoleId, a.discordRoleId].filter(Boolean).map((r: string) => `<@&${r}>`).join(' vs ');
    await discordApi(token, 'POST', `/channels/${thread.id}/messages`, {
      content: `${pings || `${h.name} vs ${a.name}`}\n**Matchweek ${weekNo} · Round ${m.round}**\nAgree your kickoff time here and post screenshots after the series.`,
      allowed_mentions: { parse: ['roles'] },
    });
    batch.update(ref, { discordThreadId: thread.id, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    threadIds[m.id] = thread.id;
  }
  batch.set(db.doc(`seasons/${seasonId}/matchweeks/${weekNo}`), {
    rounds: [...new Set(ms.map(({ m }) => m.round))].sort((x, y) => x - y), publishedAt: FieldValue.serverTimestamp(), threadIds,
  }, { merge: true });
  await batch.commit();
  const done = todo.length <= page.length;
  return { threads: done ? Object.keys(threadIds).length : 0, done, cursor: null };
});

export const completeMatchweek = onCall(async (req) => {
  requireAdmin(req);
  const { seasonId, weekNo } = req.data as { seasonId: string; weekNo: number };
  const token = DISCORD_BOT_TOKEN.value();
  const teams = await names();
  const ms = (await db.collection(`seasons/${seasonId}/matches`).where('matchweek', '==', Number(weekNo)).get()).docs
    .map((d) => ({ ref: d.ref, m: { id: d.id, ...d.data() } as Match & { discordThreadName?: string } }));
  const todo = ms.map(({ ref, m }) => ({ ref, m, name: `R${m.round} · ${teams[m.homeTeamId]?.name} ${m.seriesHome}-${m.seriesAway} ${teams[m.awayTeamId]?.name} - COMPLETED`.slice(0, 100) }))
    .filter(({ m, name }) => m.discordThreadId && m.status === 'played' && m.discordThreadName !== name);
  const page = todo.slice(0, RENAMES_PER_CALL);
  const batch = db.batch();
  let renamed = 0;
  for (const { ref, m, name } of page) {
    try { await discordApi(token, 'PATCH', `/channels/${m.discordThreadId}`, { name }); batch.update(ref, { discordThreadName: name }); renamed++; }
    catch (e) { logger.warn('rename failed', e); }
  }
  const done = todo.length <= page.length;
  if (done) batch.set(db.doc(`seasons/${seasonId}/matchweeks/${weekNo}`), { completedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  return { renamed, done, cursor: null };
});

// ---------- Upcoming games (used by /next) ----------
async function upcoming(): Promise<(Match & { seasonId: string })[]> {
  const sid = await currentSeasonId();
  if (!sid) return [];
  const cutoff = Timestamp.fromMillis(Date.now() - 3 * 3600_000);
  const ms = await db.collection(`seasons/${sid}/matches`).where('kickoffAt', '>=', cutoff).orderBy('kickoffAt').get();
  return ms.docs.map((d) => ({ id: d.id, seasonId: sid, ...d.data() }) as Match & { seasonId: string }).filter((m) => m.status !== 'played' && m.status !== 'void');
}

// ---------- Discord interactions endpoint ----------
/** Returns the HTTP response plus optional background work (the Worker passes it to waitUntil). */
export async function handleInteraction(request: Request): Promise<{ response: Response; background?: Promise<unknown> }> {
  const raw = await request.text();
  const sig = request.headers.get('X-Signature-Ed25519') || '', ts = request.headers.get('X-Signature-Timestamp') || '';
  if (!(await verifyDiscordSignature(DISCORD_PUBLIC_KEY.value(), sig, ts, raw))) return { response: new Response('invalid request signature', { status: 401 }) };
  const body = JSON.parse(raw) as {
    type: number; data?: { custom_id?: string; name?: string };
    member?: { roles: string[]; user: { id: string; global_name?: string; username: string } };
  };
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  const reply = (content: string) => json({ type: 4, data: { content, flags: 64 } });
  if (body.type === 1) return { response: json({ type: 1 }) };

  if (body.type === 2) {
    const sid = await currentSeasonId();
    const teams = await names();
    if (body.data?.name === 'standings' && sid) {
      const st = await db.doc(`seasons/${sid}/derived/standings`).get();
      const rows = ((st.data()?.rows || []) as StandingRow[]).slice(0, 12);
      const text = rows.map((r) => `\`${String(r.pos).padStart(2)}\` **${teams[r.teamId]?.name}** — ${r.pts} pts (${r.w}-${r.d}-${r.l}, ${r.gd >= 0 ? '+' : ''}${r.gd})`).join('\n');
      return { response: json({ type: 4, data: { content: `📊 **Standings**\n${text || '_No results yet._'}` } }) };
    }
    if (body.data?.name === 'next') {
      const ms = (await upcoming()).slice(0, 8);
      const text = ms.map((m) => `<t:${Math.floor((m.kickoffAt as unknown as Timestamp).toMillis() / 1000)}:f> — ${teams[m.homeTeamId]?.name} vs ${teams[m.awayTeamId]?.name}`).join('\n');
      return { response: json({ type: 4, data: { content: `🗓️ **Next up**\n${text || '_Nothing scheduled._'}` } }) };
    }
  }
  return { response: reply('Unknown command.') };
}

/** Captains (or admins) of either team set the agreed kickoff time. */
export const agreeKickoff = onCall(async (req) => {
  const uid = requireAuth(req);
  const { seasonId, cupId, matchId, kickoffAt } = req.data as { seasonId?: string; cupId?: string; matchId: string; kickoffAt: number | null };
  if (!matchId || (!seasonId && !cupId)) throw new HttpsError('invalid-argument', 'matchId and seasonId or cupId required.');
  const ref = db.doc(cupId ? `cups/${cupId}/matches/${matchId}` : `seasons/${seasonId}/matches/${matchId}`);
  const m = (await ref.get()).data();
  if (!m) throw new HttpsError('not-found', 'Match not found.');
  if (m.status === 'played') throw new HttpsError('failed-precondition', 'Match already played.');
  if (!['admin', 'owner'].includes(roleOf(req))) {
    const me = (await db.doc(`users/${uid}`).get()).data();
    const teams = await db.getAll(db.doc(`teams/${m.homeTeamId}`), db.doc(`teams/${m.awayTeamId}`));
    const ok = !!me?.playerId && teams.some((t) => (t.data()?.captainIds || []).includes(me.playerId));
    if (!ok) throw new HttpsError('permission-denied', 'Only a captain of either team can set the kickoff.');
  }
  await ref.update({
    kickoffAt: kickoffAt ? Timestamp.fromMillis(kickoffAt) : null, status: kickoffAt ? 'agreed' : 'scheduled',
    updatedBy: uid, updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/** Register /standings and /next as guild commands. */
export const registerCommands = onCall(async (req) => {
  requireAdmin(req);
  await discordApi(DISCORD_BOT_TOKEN.value(), 'PUT', `/applications/${DISCORD_CLIENT_ID.value()}/guilds/${DISCORD_GUILD_ID.value()}/commands`, [
    { name: 'standings', description: 'Current league table', type: 1 },
    { name: 'next', description: 'Next scheduled games', type: 1 },
  ]);
  return { ok: true };
});
