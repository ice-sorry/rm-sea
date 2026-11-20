import { useEffect, useMemo, useState } from 'react';
import { doc, limit, orderBy } from 'firebase/firestore';
import { setDoc } from '../lib/db';
import { API_URL, call, db } from '../lib/firebase';
import { useLeague, reloadClaims } from '../lib/league';
import { useCol, useDoc, go } from '../lib/hooks';
import { SectionHeader, Empty, Field, useAction, Confirm, Tabs } from '../components/ui';
import { fmtAgo, fmtDateTime } from '../lib/format';
import { Bot, Bug, ChartLine, Dna, FileSearch, KeyRound, Keyboard, Link, Receipt, RefreshCw, RotateCcw, Save, Tag } from 'lucide-react';

const TABS = [
  { key: 'general', label: 'General', icon: Tag },
  { key: 'discord', label: 'Discord & roles', icon: Bot },
  { key: 'webhooks', label: 'Webhooks', icon: Link },
  { key: 'analytics', label: 'Analytics', icon: ChartLine },
  { key: 'errors', label: 'Client errors', icon: Bug },
  { key: 'audit', label: 'Audit log', icon: Receipt },
  { key: 'backup', label: 'Backup', icon: Save },
  { key: 'merge', label: 'Merge duplicates', icon: Dna },
  { key: 'admins', label: 'Admins', icon: KeyRound },
];

export function AdminSettings({ tab }: { tab: string }) {
  const active = TABS.find((t) => t.key === tab)?.key || 'general';
  return (
    <>
      <SectionHeader eyebrow="System" title="League" accent="settings" />
      <Tabs tabs={TABS} active={active} onChange={(k) => go(`admin/settings?tab=${k}`)} />
      {active === 'general' && <General />}
      {active === 'discord' && <Discord />}
      {active === 'webhooks' && <Webhooks />}
      {active === 'analytics' && <Analytics />}
      {active === 'errors' && <Errors />}
      {active === 'audit' && <Audit />}
      {active === 'backup' && <Backup />}
      {active === 'merge' && <Merge />}
      {active === 'admins' && <Admins />}
    </>
  );
}

/** Small form bound to a settings doc. */
function useSettingsForm<T extends Record<string, unknown>>(path: string, defaults: T) {
  const { data } = useDoc<T>(path);
  const [f, setF] = useState<T>(defaults);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (data) { const { id: _id, ...rest } = data; void _id; setF({ ...defaults, ...rest } as T); } }, [data]);
  return [f, setF] as const;
}

function General() {
  const { run, busy } = useAction();
  const [f, setF] = useSettingsForm('settings/general', { leagueName: 'SEA Rematch League', siteUrl: '', socials: { youtube: '' } as Record<string, string>, maxRosterSize: 0 });
  return (
    <div className="card stack">
      <div className="form-grid">
        <Field label="League name"><input className="input" value={f.leagueName} onChange={(e) => setF({ ...f, leagueName: e.target.value })} /></Field>
        <Field label="Site URL (for Discord links)"><input className="input" placeholder="https://srl.web.app" value={f.siteUrl} onChange={(e) => setF({ ...f, siteUrl: e.target.value })} /></Field>
        <Field label="YouTube"><input className="input" value={f.socials?.youtube || ''} onChange={(e) => setF({ ...f, socials: { ...f.socials, youtube: e.target.value } })} /></Field>
        <Field label="Roster limit (players per team, 0 = no limit)">
          <input className="input" type="number" min={0} step={1} value={f.maxRosterSize || 0}
            onChange={(e) => setF({ ...f, maxRosterSize: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        </Field>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/general'), f, { merge: true }), 'Saved')}>Save</button>
      <p className="small muted">Current season and Home mode live under Season. A team at the roster limit can't accept join or transfer requests; admins can still add players directly under Rosters and Moves.</p>
    </div>
  );
}

function Discord() {
  const { run, busy } = useAction();
  const [f, setF] = useSettingsForm('settings/integrations', {
    guildId: '1562776724431831050', matchReportChannelId: '', alertsChannelId: '', rosterChannelId: '', autoPost: true, autoPostOnEdit: false,
    discordEnabled: true, rosterPosts: true, requestPosts: true, roleSync: true, matchThreads: true,
  });
  // Older settings docs lack the switches; a missing switch counts as on (the Worker reads it the same way).
  const on = (k: 'discordEnabled' | 'rosterPosts' | 'requestPosts' | 'roleSync' | 'matchThreads') => f[k] !== false;
  const toggle = (k: 'discordEnabled' | 'rosterPosts' | 'requestPosts' | 'roleSync' | 'matchThreads', label: string, hint: string) => (
    <label className="check" title={hint}><input type="checkbox" disabled={k !== 'discordEnabled' && !on('discordEnabled')} checked={on(k)} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />{label}</label>
  );
  const text = (k: keyof typeof f, label: string) => <Field label={label}><input className="input" value={String(f[k] ?? '')} onChange={(e) => setF({ ...f, [k]: e.target.value.trim() })} /></Field>;
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Discord features</h3>
        <div className="row wrap">{toggle('discordEnabled', 'Discord on', 'Master switch: off stops every bot post, role change and webhook')}</div>
        <div className="row wrap">
          {toggle('rosterPosts', 'Roster move posts', 'Post when a player signs for or leaves a team, or a new team is created')}
          {toggle('requestPosts', 'Admin request posts', 'Post when someone makes a request only an admin can approve: a new club, a season entry or exit, or a removal')}
          {toggle('roleSync', 'Team role sync', 'Give and remove team roles when rosters change')}
          {toggle('matchThreads', 'Matchweek threads', 'Create and rename fixture threads')}
          <label className="check"><input type="checkbox" disabled={!on('discordEnabled')} checked={!!f.autoPost} onChange={(e) => setF({ ...f, autoPost: e.target.checked })} />Auto-post results</label>
          <label className="check"><input type="checkbox" disabled={!on('discordEnabled') || !f.autoPost} checked={!!f.autoPostOnEdit} onChange={(e) => setF({ ...f, autoPostOnEdit: e.target.checked })} />…and when a result is edited</label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>With Discord off, nothing is sent to Discord: no posts, role changes, threads, rules or results. Sign-in with Discord keeps working. Turning role sync back on doesn't catch up on its own; press <b>Sync team roles</b> below.</p>
        <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/integrations'), f, { merge: true }), 'Saved')}>Save</button>
      </div>
      <div className="card stack">
        <div className="form-grid">
          {text('guildId', 'Guild (server) ID')}{text('matchReportChannelId', 'Match report channel ID')}{text('alertsChannelId', 'Alerts channel ID')}{text('rosterChannelId', 'Roster moves channel ID')}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Roster moves: the bot posts there when a player signs for or leaves a team, or a new team is created. Alerts: the bot posts there when someone asks for a new club, a season entry or exit, or a player's removal, so an admin can approve it. Leave a channel blank to turn its posts off. The bot needs Send Messages and Embed Links in those channels.</p>
        <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/integrations'), f, { merge: true }), 'Saved')}>Save</button>
      </div>
      <div className="card row wrap">
        <button className="btn" disabled={busy} onClick={() => run(() => call<unknown, { added: number; removed: number }>('syncRoles')({}), (r) => `Roles synced: ${r.added} added, ${r.removed} removed`)}><RefreshCw size={15} aria-hidden />Sync team roles</button>
        <button className="btn" disabled={busy} onClick={() => run(() => call('registerCommands')({}), 'Registered /standings and /next')}><Keyboard size={15} aria-hidden />Register slash commands</button>
        <button className="btn" disabled={busy} onClick={() => run(async () => { await call('refreshClaims')({}); await reloadClaims(); })}><KeyRound size={15} aria-hidden />Refresh my claims</button>
      </div>
      <p className="small muted">Interactions endpoint for the Discord app: <code>{API_URL || 'https://<your-worker>.workers.dev'}/interactions</code></p>
    </div>
  );
}

function Webhooks() {
  const { run, busy } = useAction();
  const { data } = useDoc<Record<string, string>>('private/discord');
  const keys = ['resultWebhookUrl', 'rulesWebhookUrl'];
  const [f, setF] = useState<Record<string, string>>({});
  const mask = (v?: string) => (v ? `${v.slice(0, 45)}…${v.slice(-4)}` : 'not set');
  return (
    <div className="card stack">
      <p className="small muted">Stored in <code>private/discord</code> — admin read, Worker write. Leave a field blank to keep its current value.</p>
      {keys.map((k) => (
        <Field key={k} label={`${k} · ${mask(data?.[k])}`}><input className="input" placeholder="https://discord.com/api/webhooks/…" value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
      ))}
      <button className="btn primary" disabled={busy || !Object.values(f).some(Boolean)} onClick={() => run(async () => {
        await call('savePrivate')(Object.fromEntries(Object.entries(f).filter(([, v]) => v)));
        setF({});
      }, 'Webhooks saved')}>Save webhooks</button>
    </div>
  );
}

function Analytics() {
  const { data } = useCol<{ uniques: number; day: string }>('analytics', orderBy('day', 'desc'), limit(30));
  const days = [...data].reverse();
  const max = Math.max(1, ...days.map((d) => d.uniques || 0));
  return (
    <div className="card">
      <h3>Unique visitors (per browser per UTC day)</h3>
      {!days.length ? <Empty>No visits recorded yet.</Empty> : (
        <div className="row" style={{ alignItems: 'flex-end', height: 180, gap: 3 }}>
          {days.map((d) => (
            <div key={d.id} title={`${d.id}: ${d.uniques}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <span className="small muted">{d.uniques}</span>
              <div style={{ width: '100%', height: `${(d.uniques / max) * 140}px`, background: 'var(--accent-2)', borderRadius: '3px 3px 0 0' }} />
            </div>
          ))}
        </div>
      )}
      <div className="small muted" style={{ marginTop: 8 }}>{days[0]?.id} → {days[days.length - 1]?.id} · total {days.reduce((s, d) => s + (d.uniques || 0), 0)}</div>
    </div>
  );
}

function Errors() {
  const { data } = useCol<{ message: string; stack: string; url: string; userAgent: string; uid: string | null; firstAt: { toMillis(): number } }>('clientErrors', orderBy('firstAt', 'desc'), limit(50));
  return (
    <div className="stack">
      {!data.length && <Empty>No client errors reported.</Empty>}
      {data.map((e) => (
        <details key={e.id} className="card">
          <summary style={{ cursor: 'pointer' }}><b>{e.message}</b> <span className="small muted">· {fmtAgo(e.firstAt)} · {e.uid || 'anonymous'}</span></summary>
          <div className="small muted">{e.url}<br />{e.userAgent}</div>
          <pre className="json">{e.stack}</pre>
        </details>
      ))}
    </div>
  );
}

function Audit() {
  const { run, busy } = useAction();
  const { data } = useCol<{ at: { toMillis(): number }; actorUid: string; actorName: string; kind: string; path: string; op: string; diff: Record<string, { from: unknown; to: unknown }> | null; note: string | null; before: unknown; after: unknown }>(
    'auditLog', orderBy('at', 'desc'), limit(150));
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const list = data.filter((e) => !q || `${e.actorName} ${e.path} ${e.note || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack">
      <div className="row"><input className="input" placeholder="Filter by actor, path or note…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="row"><input className="input" placeholder="Add an admin note to the log…" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn" disabled={busy || !note} onClick={() => run(async () => { await call('addAuditNote')({ note }); setNote(''); }, 'Note added')}>Add note</button></div>
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>Actor</th><th>Op</th><th>Path</th><th>Change</th></tr></thead>
          <tbody>{list.map((e) => (
            <tr key={e.id}>
              <td className="small">{fmtDateTime(e.at)}</td>
              <td className="small">{e.actorName}{e.kind === 'note' && <span className="badge" style={{ marginLeft: 4 }}>note</span>}</td>
              <td className="small">{e.op}</td>
              <td className="small">{e.path}</td>
              <td className="small" style={{ whiteSpace: 'normal' }}>
                {e.note && <div>{e.note}</div>}
                {e.diff && <details><summary>{Object.keys(e.diff).join(', ')}</summary><pre className="json">{JSON.stringify(e.diff, null, 1)}</pre></details>}
                {!e.diff && e.op !== 'update' && e.kind !== 'note' && <details><summary>{e.op === 'create' ? 'created doc' : 'deleted doc'}</summary><pre className="json">{JSON.stringify(e.op === 'create' ? e.after : e.before, null, 1)}</pre></details>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Backup() {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: points } = useCol<{ createdAt: { toMillis(): number }; reason: string; chunks?: number; total: number; counts: Record<string, number> }>('restorePoints', orderBy('createdAt', 'desc'), limit(30));
  const [result, setResult] = useState<string>('');
  const download = (json: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `srl-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const restoreFile = (file: File, dryRun: boolean) => run(async () => {
    const { docs } = JSON.parse(await file.text()) as { docs: Record<string, unknown> };
    if (!docs || typeof docs !== 'object') throw new Error('That is not an SRL backup file.');
    setResult(JSON.stringify(await call('restoreMissing')({ docs, dryRun }), null, 2));
  }, dryRun ? undefined : 'Restore complete');
  return (
    <div className="stack">
      <div className="card row wrap">
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await call<unknown, { total: number; json: string }>('backupNow')({}); download(r.json); return r; }, (r) => `Backed up ${r.total} documents — a copy was downloaded`)}><Save size={15} aria-hidden />Back up now</button>
        <span className="small muted">Backups are manual on the free plan: each one is stored here and downloaded as a JSON file — keep those somewhere safe. Restore only re-creates documents missing from live data — it never overwrites.</span>
      </div>
      {L.isOwner && (
        <div className="card row wrap">
          <span className="small">Restore from a downloaded backup file:</span>
          <label className="btn sm"><FileSearch size={14} aria-hidden />Dry run<input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) restoreFile(f, true); }} /></label>
          <label className="btn sm primary"><RotateCcw size={14} aria-hidden />Restore missing<input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && confirm('Re-create documents missing from live data?')) restoreFile(f, false); }} /></label>
        </div>
      )}
      {result && <pre className="json">{result}</pre>}
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>Reason</th><th className="n">Docs</th><th /></tr></thead>
          <tbody>{points.map((p) => (
            <tr key={p.id}>
              <td>{fmtDateTime(p.createdAt)}</td><td className="small">{p.reason}</td><td className="n">{p.total}</td>
              <td className="right">{L.isOwner ? <>
                <button className="btn sm" disabled={busy} onClick={() => run(async () => setResult(JSON.stringify(await call('restoreMissing')({ pointId: p.id, dryRun: true }), null, 2)))}>Dry run</button>{' '}
                <Confirm className="btn sm primary" text="Re-create documents missing from live data?" onYes={() => run(async () => setResult(JSON.stringify(await call('restoreMissing')({ pointId: p.id }), null, 2)), 'Restore complete')}>Restore missing</Confirm>
              </> : <span className="small muted">owner only</span>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!points.length && <Empty>No restore points yet.</Empty>}
      </div>
    </div>
  );
}

function Merge() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [kind, setKind] = useState<'player' | 'team'>('player');
  const [pair, setPair] = useState({ removeId: '', keepId: '' });
  const dupes = useMemo(() => {
    const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const groups = new Map<string, string[]>();
    if (kind === 'player') L.playerList.forEach((p) => groups.set(key(p.name), [...(groups.get(key(p.name)) || []), p.id]));
    else L.teamList.forEach((t) => groups.set(t.nameNormalized || key(t.name), [...(groups.get(t.nameNormalized || key(t.name)) || []), t.id]));
    return [...groups.values()].filter((g) => g.length > 1);
  }, [kind, L.playerList, L.teamList]);
  const list = kind === 'player' ? L.playerList : L.teamList;
  const label = (id: string) => (kind === 'player' ? `${L.players[id]?.name}${L.players[id]?.discordId ? ' (linked)' : ''}` : L.teams[id]?.name);
  if (!L.isOwner) return <Empty>Merging is owner-only.</Empty>;
  return (
    <div className="stack">
      <Tabs tabs={[{ key: 'player', label: 'Players' }, { key: 'team', label: 'Teams' }]} active={kind} onChange={(k) => { setKind(k); setPair({ removeId: '', keepId: '' }); }} />
      <div className="card">
        <h3>Possible duplicates</h3>
        {!dupes.length && <Empty>No duplicate names found.</Empty>}
        {dupes.map((g) => <div key={g.join()} className="row small" style={{ padding: '4px 0' }}>{g.map((id) => <button key={id} className="btn sm" onClick={() => setPair({ keepId: g.find((x) => x !== id)!, removeId: id })}>remove {label(id)}</button>)}</div>)}
      </div>
      <div className="card stack">
        <div className="form-grid">
          <Field label="Remove (merged away)"><select className="select" value={pair.removeId} onChange={(e) => setPair({ ...pair, removeId: e.target.value })}><option value="">—</option>{list.map((x) => <option key={x.id} value={x.id}>{label(x.id)} · {x.id.slice(0, 6)}</option>)}</select></Field>
          <Field label="Keep"><select className="select" value={pair.keepId} onChange={(e) => setPair({ ...pair, keepId: e.target.value })}><option value="">—</option>{list.map((x) => <option key={x.id} value={x.id}>{label(x.id)} · {x.id.slice(0, 6)}</option>)}</select></Field>
        </div>
        <Confirm className="btn primary" text="Merge? Every fixture, result, roster, award and allowlist reference is rewritten to the kept ID. A backup is taken first." onYes={() => run(() => call<unknown, { rewritten: number; moved: number }>('mergeEntities')({ kind, ...pair }), (r) => `Merged: ${r.rewritten} docs rewritten, ${r.moved} moved`)}>
          {busy ? 'Merging…' : <><Dna size={15} aria-hidden />Merge</>}
        </Confirm>
      </div>
    </div>
  );
}

function Admins() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [f, setF] = useSettingsForm('settings/admins', { adminUids: [] as string[], ownerUids: [] as string[], adminRoleIds: ['1562781903604424794', '1563169917384134827'] as string[], playerRoleIds: [] as string[] });
  const [uid, setUid] = useState('');
  const lines = (v: string[]) => v.join('\n');
  const parse = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  if (!L.isOwner) return <Empty>Only owners can manage admins. Admins: {f.adminUids.length}</Empty>;
  return (
    <div className="stack">
      <div className="card stack">
        <p className="small muted">UIDs look like <code>discord:123456789012345678</code>. Anyone holding an admin Discord role is also an admin.</p>
        <div className="grid-3">
          <Field label="Owner UIDs"><textarea className="textarea" value={lines(f.ownerUids)} onChange={(e) => setF({ ...f, ownerUids: parse(e.target.value) })} /></Field>
          <Field label="Admin UIDs"><textarea className="textarea" value={lines(f.adminUids)} onChange={(e) => setF({ ...f, adminUids: parse(e.target.value) })} /></Field>
          <Field label="Admin Discord role IDs"><textarea className="textarea" value={lines(f.adminRoleIds)} onChange={(e) => setF({ ...f, adminRoleIds: parse(e.target.value) })} /></Field>
        </div>
        <Field label="Player Discord role IDs (e.g. Verified)"><textarea className="textarea" value={lines(f.playerRoleIds || [])} onChange={(e) => setF({ ...f, playerRoleIds: parse(e.target.value) })} /></Field>
        <p className="small muted" style={{ margin: 0 }}>Only Discord members holding one of these roles can create a player. Leave empty to let anyone register.
          Players an admin already linked to an account can still be claimed.</p>
        <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/admins'), f), 'Admins saved — refresh their claims below')}>Save</button>
      </div>
      <div className="card row">
        <input className="input" placeholder="discord:… uid to refresh" value={uid} onChange={(e) => setUid(e.target.value)} />
        <button className="btn" disabled={busy || !uid} onClick={() => run(() => call<unknown, { role: string }>('refreshClaims')({ uid }), (r) => `Role is now ${r.role} (applies on their next token refresh)`)}>Refresh claims</button>
      </div>
    </div>
  );
}
