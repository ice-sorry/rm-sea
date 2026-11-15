import { useEffect, useMemo, useState } from 'react';
import { doc, limit, orderBy } from 'firebase/firestore';
import { setDoc } from '../lib/db';
import { API_URL, call, db } from '../lib/firebase';
import { useLeague, reloadClaims } from '../lib/league';
import { useCol, useDoc, go } from '../lib/hooks';
import { SectionHeader, Empty, Field, useAction, Confirm, Tabs } from '../components/ui';
import { fmtAgo, fmtDateTime } from '../lib/format';

const TABS = [
  { key: 'general', label: 'General', emoji: '🏷️' },
  { key: 'discord', label: 'Discord & roles', emoji: '🤖' },
  { key: 'webhooks', label: 'Webhooks', emoji: '🔗' },
  { key: 'analytics', label: 'Analytics', emoji: '📈' },
  { key: 'errors', label: 'Client errors', emoji: '🐞' },
  { key: 'audit', label: 'Audit log', emoji: '🧾' },
  { key: 'backup', label: 'Backup', emoji: '💾' },
  { key: 'merge', label: 'Merge duplicates', emoji: '🧬' },
  { key: 'admins', label: 'Admins', emoji: '🔑' },
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
  const [f, setF] = useSettingsForm('settings/general', { leagueName: 'SEA Rematch League', siteUrl: '', socials: { youtube: '' } as Record<string, string> });
  return (
    <div className="card stack">
      <div className="form-grid">
        <Field label="League name"><input className="input" value={f.leagueName} onChange={(e) => setF({ ...f, leagueName: e.target.value })} /></Field>
        <Field label="Site URL (for Discord links)"><input className="input" placeholder="https://srl.web.app" value={f.siteUrl} onChange={(e) => setF({ ...f, siteUrl: e.target.value })} /></Field>
        <Field label="YouTube"><input className="input" value={f.socials?.youtube || ''} onChange={(e) => setF({ ...f, socials: { ...f.socials, youtube: e.target.value } })} /></Field>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/general'), f, { merge: true }), 'Saved')}>Save</button>
      <p className="small muted">Current season and Home mode live under Season.</p>
    </div>
  );
}

function Discord() {
  const { run, busy } = useAction();
  const [f, setF] = useSettingsForm('settings/integrations', {
    guildId: '1562776724431831050', matchReportChannelId: '', alertsChannelId: '', rosterChannelId: '', autoPost: true, autoPostOnEdit: false,
  });
  const text = (k: keyof typeof f, label: string) => <Field label={label}><input className="input" value={String(f[k] ?? '')} onChange={(e) => setF({ ...f, [k]: e.target.value.trim() })} /></Field>;
  return (
    <div className="stack">
      <div className="card stack">
        <div className="form-grid">
          {text('guildId', 'Guild (server) ID')}{text('matchReportChannelId', 'Match report channel ID')}{text('alertsChannelId', 'Alerts channel ID')}{text('rosterChannelId', 'Roster moves channel ID')}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Roster moves: the bot posts there when a player signs for or leaves a team. Leave it blank to turn the posts off. The bot needs Send Messages and Embed Links in that channel.</p>
        <div className="row wrap">
          <label className="check"><input type="checkbox" checked={!!f.autoPost} onChange={(e) => setF({ ...f, autoPost: e.target.checked })} />Auto-post results to Discord</label>
          <label className="check"><input type="checkbox" checked={!!f.autoPostOnEdit} onChange={(e) => setF({ ...f, autoPostOnEdit: e.target.checked })} />…and when a result is edited</label>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/integrations'), f, { merge: true }), 'Saved')}>Save</button>
      </div>
      <div className="card row wrap">
        <button className="btn" disabled={busy} onClick={() => run(() => call<unknown, { added: number; removed: number }>('syncRoles')({}), (r) => `Roles synced: ${r.added} added, ${r.removed} removed`)}>🔄 Sync team roles</button>
        <button className="btn" disabled={busy} onClick={() => run(() => call('registerCommands')({}), 'Registered /standings and /next')}>⌨️ Register slash commands</button>
        <button className="btn" disabled={busy} onClick={() => run(async () => { await call('refreshClaims')({}); await reloadClaims(); })}>🔑 Refresh my claims</button>
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
      {!data.length && <Empty>No client errors reported. 🎉</Empty>}
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
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await call<unknown, { total: number; json: string }>('backupNow')({}); download(r.json); return r; }, (r) => `Backed up ${r.total} documents — a copy was downloaded`)}>💾 Back up now</button>
        <span className="small muted">Backups are manual on the free plan: each one is stored here and downloaded as a JSON file — keep those somewhere safe. Restore only re-creates documents missing from live data — it never overwrites.</span>
      </div>
      {L.isOwner && (
        <div className="card row wrap">
          <span className="small">Restore from a downloaded backup file:</span>
          <label className="btn sm">🔍 Dry run<input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) restoreFile(f, true); }} /></label>
          <label className="btn sm primary">♻️ Restore missing<input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && confirm('Re-create documents missing from live data?')) restoreFile(f, false); }} /></label>
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
          {busy ? 'Merging…' : '🧬 Merge'}
        </Confirm>
      </div>
    </div>
  );
}

function Admins() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [f, setF] = useSettingsForm('settings/admins', { adminUids: [] as string[], ownerUids: [] as string[], adminRoleIds: ['1562781903604424794', '1563169917384134827'] as string[] });
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
        <button className="btn primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/admins'), f), 'Admins saved — refresh their claims below')}>Save</button>
      </div>
      <div className="card row">
        <input className="input" placeholder="discord:… uid to refresh" value={uid} onChange={(e) => setUid(e.target.value)} />
        <button className="btn" disabled={busy || !uid} onClick={() => run(() => call<unknown, { role: string }>('refreshClaims')({ uid }), (r) => `Role is now ${r.role} (applies on their next token refresh)`)}>Refresh claims</button>
      </div>
    </div>
  );
}
