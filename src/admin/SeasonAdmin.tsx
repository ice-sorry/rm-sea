import { useState } from 'react';
import { collection, doc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { addDoc, deleteDoc, setDoc, updateDoc, writeBatch } from '../lib/db';
import { call, db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useCol, useDoc } from '../lib/hooks';
import { SectionHeader, Empty, Crest, Field, useAction, Confirm, Tabs } from '../components/ui';
import { BracketView } from '../components/league';
import { buildFinalsBracket, DEFAULT_SEASON } from '../lib/types';
import type { Award, Bracket, Season, SeasonStatus } from '../lib/types';
import { toLocalInput } from '../lib/format';
import { actor } from './util';

const STATUSES: SeasonStatus[] = ['draft', 'signups', 'live', 'finals', 'complete'];
const json = (v: unknown) => JSON.stringify(v, null, 2);

// ======================= Season =======================
export function AdminSeason() {
  const L = useLeague();
  const [tab, setTab] = useState<'settings' | 'teams' | 'home' | 'launch'>('settings');
  return (
    <>
      <SectionHeader eyebrow="Season" title={L.season?.name || 'No season'} accent="setup" />
      <div className="card row wrap">
        <span className="small muted">Editing</span>
        <select className="select" style={{ width: 'auto' }} value={L.seasonId || ''} onChange={(e) => L.setSeasonId(e.target.value)}>
          {L.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === L.general.currentSeasonId ? ' (current)' : ''}</option>)}
        </select>
        {L.seasonId && L.seasonId !== L.general.currentSeasonId && <SetCurrent id={L.seasonId} />}
      </div>
      <Tabs tabs={[{ key: 'settings', label: 'Settings', emoji: '⚙️' }, { key: 'teams', label: 'Teams & divisions', emoji: '🛡️' }, { key: 'home', label: 'Home & Wrapped', emoji: '🏠' }, { key: 'launch', label: 'Season launch', emoji: '🚀' }]} active={tab} onChange={setTab} />
      {tab === 'settings' && (L.season ? <SeasonSettings key={L.season.id} season={L.season} /> : <Empty>Launch a season first.</Empty>)}
      {tab === 'teams' && (L.season ? <Entries /> : <Empty>Launch a season first.</Empty>)}
      {tab === 'home' && <HomeAndWrapped />}
      {tab === 'launch' && <LaunchWizard />}
    </>
  );
}

function SetCurrent({ id }: { id: string }) {
  const { run, busy } = useAction();
  return <button className="btn sm primary" disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/general'), { currentSeasonId: id }, { merge: true }), 'Current season set')}>Make current</button>;
}

function SeasonSettings({ season }: { season: Season }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({
    name: season.name, status: season.status, locked: season.locked, roundsPerWeek: season.roundsPerWeek, divided: season.divided,
    kickoff: toLocalInput(season.kickoffDate),
    scoring: json(season.scoring), seriesFormat: json(season.seriesFormat), tiebreakers: season.tiebreakers.join(','),
    divisions: json(season.divisions), zones: json(season.zones), finalsFormat: json(season.finalsFormat),
  });
  const save = () => run(async () => {
    const parse = (s: string, label: string) => { try { return JSON.parse(s); } catch { throw new Error(`${label} is not valid JSON`); } };
    await updateDoc(doc(db, 'seasons', season.id), {
      name: f.name, status: f.status, locked: f.locked, roundsPerWeek: Number(f.roundsPerWeek) || 2, divided: f.divided,
      kickoffDate: f.kickoff ? Timestamp.fromDate(new Date(f.kickoff)) : null,
      scoring: parse(f.scoring, 'Scoring'), seriesFormat: parse(f.seriesFormat, 'Series format'),
      tiebreakers: f.tiebreakers.split(',').map((s) => s.trim()).filter(Boolean),
      divisions: parse(f.divisions, 'Divisions'), zones: parse(f.zones, 'Zones'), finalsFormat: parse(f.finalsFormat, 'Finals format'),
    });
    // Completing a season generates its Wrapped (formerly a Firestore trigger).
    if (f.status === 'complete' && season.status !== 'complete') await call('buildWrapped')({ seasonId: season.id });
  }, 'Season saved');
  const ta = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label}><textarea className="textarea" value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} />{hint && <span className="small muted">{hint}</span>}</Field>
  );
  return (
    <div className="card stack">
      <div className="form-grid">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as SeasonStatus })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Rounds per matchweek"><input className="input" type="number" min={1} value={f.roundsPerWeek} onChange={(e) => setF({ ...f, roundsPerWeek: Number(e.target.value) })} /></Field>
        <Field label="Season start"><input className="input" type="datetime-local" value={f.kickoff} onChange={(e) => setF({ ...f, kickoff: e.target.value })} /><span className="small muted">Home shows a countdown while the season is draft or signups.</span></Field>
      </div>
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={f.locked} onChange={(e) => setF({ ...f, locked: e.target.checked })} />🔒 Locked (blocks result edits)</label>
        <label className="check"><input type="checkbox" checked={f.divided} onChange={(e) => setF({ ...f, divided: e.target.checked })} />Divisions on</label>
      </div>
      <div className="grid-2">
        {ta('scoring', 'Scoring (points per game)', '{ "win": 3, "draw": 1, "loss": 0 }')}
        {ta('seriesFormat', 'Series format', 'Games per fixture. Default { "minGames": 2, "maxGames": 2, "rule": "leadBy2" } = always 2 games')}
        {ta('zones', 'Table zones', '{from, to, label, color, kind} — first matching zone colours the row band')}
        {ta('finalsFormat', 'Finals format', 'qualifiers, byeSeeds, directSeeds, wildcardSeeds')}
        {ta('divisions', 'Divisions', '[{ "id": "north", "name": "North" }]')}
        <Field label="Tiebreakers (comma separated)"><input className="input" value={f.tiebreakers} onChange={(e) => setF({ ...f, tiebreakers: e.target.value })} /><span className="small muted">pts, gd, gf, w, h2h</span></Field>
      </div>
      <div className="row"><button className="btn primary" disabled={busy} onClick={save}>Save season</button>
        <button className="btn ghost" onClick={() => setF({ ...f, zones: json(DEFAULT_SEASON.zones), finalsFormat: json(DEFAULT_SEASON.finalsFormat) })}>Reset zones & finals to defaults</button></div>
    </div>
  );
}

function Entries() {
  const L = useLeague();
  const { run, busy } = useAction();
  const entered = new Set(L.entries.map((e) => e.teamId));
  const path = (t: string) => `seasons/${L.seasonId}/entries/${t}`;
  return (
    <div className="card flush table-wrap">
      <table className="data">
        <thead><tr><th>Team</th><th>Entered</th><th>Confirmed</th><th>Division</th><th>Seed</th></tr></thead>
        <tbody>{L.teamList.filter((t) => t.active !== false || entered.has(t.id)).map((t) => {
          const e = L.entries.find((x) => x.teamId === t.id);
          return (
            <tr key={t.id}>
              <td><span className="team-cell"><Crest team={t} size="sm" />{t.name}</span></td>
              <td><input type="checkbox" disabled={busy} checked={!!e} onChange={(ev) => run(() => ev.target.checked
                ? setDoc(doc(db, path(t.id)), { confirmed: true, divisionId: null, seed: null, joinedAt: serverTimestamp() })
                : deleteDoc(doc(db, path(t.id))))} /></td>
              <td>{e && <input type="checkbox" checked={e.confirmed} onChange={(ev) => run(() => updateDoc(doc(db, path(t.id)), { confirmed: ev.target.checked }))} />}</td>
              <td>{e && L.season?.divided && (
                <select className="select" value={e.divisionId || ''} onChange={(ev) => run(() => updateDoc(doc(db, path(t.id)), { divisionId: ev.target.value || null }))}>
                  <option value="">—</option>{L.season.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>)}</td>
              <td>{e && <input className="input num-in" type="number" min={1} value={e.seed ?? ''} onChange={(ev) => run(() => updateDoc(doc(db, path(t.id)), { seed: ev.target.value ? Number(ev.target.value) : null }))} />}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function HomeAndWrapped() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [until, setUntil] = useState(toLocalInput(L.season?.wrappedOpenUntil));
  return (
    <div className="grid-2">
      <div className="card stack">
        <h3>🏠 Home page mode</h3>
        <p className="small muted">Pin a finished season's celebration to Home while the next season is built.</p>
        <div className="row wrap">
          <button className={`btn ${L.general.homeMode !== 'pinned' ? 'primary' : ''}`} disabled={busy} onClick={() => run(() => setDoc(doc(db, 'settings/general'), { homeMode: 'live' }, { merge: true }), 'Home is live')}>Live</button>
          {L.seasons.map((s) => (
            <button key={s.id} className={`btn sm ${L.general.homeMode === 'pinned' && L.general.pinnedSeasonId === s.id ? 'primary' : ''}`} disabled={busy}
              onClick={() => run(() => setDoc(doc(db, 'settings/general'), { homeMode: 'pinned', pinnedSeasonId: s.id }, { merge: true }), `Pinned ${s.name}`)}>📌 {s.name}</button>
          ))}
        </div>
      </div>
      <div className="card stack">
        <h3>🎁 Wrapped</h3>
        <p className="small muted">Per-player recap slides. Built automatically when a season is marked complete.</p>
        <Field label="Open until"><input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        <div className="row">
          <button className="btn" disabled={busy || !L.seasonId} onClick={() => run(() => updateDoc(doc(db, 'seasons', L.seasonId!), { wrappedOpenUntil: until ? Timestamp.fromDate(new Date(until)) : null }), 'Saved')}>Save window</button>
          <button className="btn primary" disabled={busy || !L.seasonId} onClick={() => run(() => call<unknown, { players: number }>('buildWrapped')({ seasonId: L.seasonId }), (r) => `Built Wrapped for ${r.players} players`)}>Build Wrapped now</button>
        </div>
      </div>
    </div>
  );
}

/** Four-step season move wizard backed by moveToNextSeason. */
function LaunchWizard() {
  const L = useLeague();
  const { run, busy } = useAction();
  const prev = L.seasons[0];
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ number: (prev?.number || 0) + 1, name: '', fromSeasonId: prev?.id || '', teamIds: [] as string[], copyRosters: true, status: 'signups', setCurrent: true, completePrevious: true, startsAt: '' });
  const steps = ['Basics', 'Teams', 'Rosters & status', 'Review'];
  return (
    <div className="card stack">
      <div className="steps">{steps.map((s, i) => <span key={s} className={`step ${step === i + 1 ? 'on' : ''}`}><b>{i + 1}</b>{s}</span>)}</div>
      {step === 1 && (
        <div className="form-grid">
          <Field label="Season number"><input className="input" type="number" min={1} value={f.number} onChange={(e) => setF({ ...f, number: Number(e.target.value) })} /></Field>
          <Field label="Name"><input className="input" placeholder={`Season ${f.number}`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Season start (optional)"><input className="input" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
          <Field label="Carry settings from"><select className="select" value={f.fromSeasonId} onChange={(e) => setF({ ...f, fromSeasonId: e.target.value })}><option value="">Defaults</option>{L.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        </div>
      )}
      {step === 2 && (
        <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Optional: a season can start with no teams. Add or remove teams later under <b>Teams &amp; divisions</b>, and captains can request to join from their team page.</p>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setF({ ...f, teamIds: L.entries.map((e) => e.teamId) })} disabled={!L.entries.length}>Same as {L.season?.name || 'selected season'}</button>
          <button className="btn sm" onClick={() => setF({ ...f, teamIds: L.teamList.filter((t) => t.active !== false).map((t) => t.id) })}>All active teams</button>
          <button className="btn sm ghost" onClick={() => setF({ ...f, teamIds: [] })}>None</button>
        </div>
        <div className="row wrap">{L.teamList.map((t) => (
          <label key={t.id} className="check card" style={{ padding: '6px 10px' }}><input type="checkbox" checked={f.teamIds.includes(t.id)}
            onChange={(e) => setF({ ...f, teamIds: e.target.checked ? [...f.teamIds, t.id] : f.teamIds.filter((x) => x !== t.id) })} /><Crest team={t} size="sm" />{t.name}</label>
        ))}</div>
        </div>
      )}
      {step === 3 && (
        <div className="stack">
          <label className="check"><input type="checkbox" checked={f.copyRosters} disabled={!f.fromSeasonId} onChange={(e) => setF({ ...f, copyRosters: e.target.checked })} />Copy rosters from the previous season</label>
          <label className="check"><input type="checkbox" checked={f.setCurrent} onChange={(e) => setF({ ...f, setCurrent: e.target.checked })} />Make it the current season</label>
          <label className="check"><input type="checkbox" checked={f.completePrevious} disabled={!f.fromSeasonId} onChange={(e) => setF({ ...f, completePrevious: e.target.checked })} />Mark the previous season complete & locked</label>
          <Field label="Starting status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        </div>
      )}
      {step === 4 && (
        <dl className="kv">
          <dt>Season</dt><dd>s{f.number} · {f.name || `Season ${f.number}`}</dd>
          <dt>Settings from</dt><dd>{f.fromSeasonId || 'defaults'}</dd>
          <dt>Starts</dt><dd>{f.startsAt ? new Date(f.startsAt).toLocaleString() : 'not set'}</dd>
          <dt>Teams</dt><dd>{f.teamIds.length || 'none yet (add later)'}</dd>
          <dt>Rosters</dt><dd>{f.copyRosters && f.fromSeasonId ? 'copied' : 'empty'}</dd>
          <dt>Status</dt><dd>{f.status}{f.setCurrent ? ' · current' : ''}</dd>
        </dl>
      )}
      <div className="row">
        <button className="btn ghost" disabled={step === 1} onClick={() => setStep(step - 1)}>Back</button>
        <button className="btn ghost" onClick={() => setStep(1)}>Cancel</button>
        <span className="grow" />
        {step < 4 ? <button className="btn primary" onClick={() => setStep(step + 1)}>Next</button>
          : <button className="btn primary" disabled={busy} onClick={() => run(async () => {
            const r = await call<unknown, { seasonId: string }>('moveToNextSeason')({ ...f, startsAt: undefined, kickoffDate: f.startsAt ? new Date(f.startsAt).getTime() : null, fromSeasonId: f.fromSeasonId || undefined });
            L.setSeasonId(r.seasonId); setStep(1);
            return r;
          }, (r) => `Launched ${r.seasonId}`)}>🚀 Launch season</button>}
      </div>
    </div>
  );
}

// ======================= Playoffs =======================
export function AdminPlayoffs() {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: brackets } = useCol<Bracket>(L.seasonId ? `seasons/${L.seasonId}/playoffs` : null);
  const [editSlot, setEditSlot] = useState<{ bracketId: string; slot: string } | null>(null);
  const rows = L.standings?.rows || [];
  const generate = () => run(async () => {
    const fmt = L.season!.finalsFormat;
    const finals = buildFinalsBracket(fmt, (seed) => rows[seed - 1]?.teamId ?? null);
    await setDoc(doc(db, `seasons/${L.seasonId}/playoffs/finals`), finals);
    await updateDoc(doc(db, 'seasons', L.seasonId!), { status: 'finals' });
    await call('recomputeAll')({ seasonId: L.seasonId }); // creates slot fixtures
  }, 'Bracket drawn from the table — fixtures created');
  const reset = () => run(async () => {
    const b = writeBatch(db);
    brackets.forEach((x) => b.delete(doc(db, `seasons/${L.seasonId}/playoffs/${x.id}`)));
    L.matches.filter((m) => m.bracketSlot).forEach((m) => b.delete(doc(db, `seasons/${L.seasonId}/matches/${m.id}`)));
    await b.commit();
    await call('recomputeAll')({ seasonId: L.seasonId });
  }, 'Bracket reset');
  const setSlotTeam = (bracketId: string, slot: string, side: 'homeTeamId' | 'awayTeamId', teamId: string) => run(async () => {
    const b = brackets.find((x) => x.id === bracketId)!;
    const rounds = b.rounds.map((r) => ({ ...r, slots: r.slots.map((s) => (s.slot === slot ? { ...s, [side]: teamId || null } : s)) }));
    await updateDoc(doc(db, `seasons/${L.seasonId}/playoffs/${bracketId}`), { rounds });
    await call('recomputeAll')({ seasonId: L.seasonId });
  }, 'Slot updated');
  const editing = editSlot && brackets.find((b) => b.id === editSlot.bracketId)?.rounds.flatMap((r) => r.slots).find((s) => s.slot === editSlot.slot);
  return (
    <>
      <SectionHeader eyebrow="Season" title="Playoff" accent="bracket" />
      <div className="card stack">
        <p className="small muted">Seeds come from the current table using the season's finals format (byes, direct QF seeds, wildcard seeds). Winners advance automatically; deleting a result rolls the bracket back.</p>
        <div className="row wrap">
          <Confirm className="btn primary" text="Draw the finals bracket from the current standings?" onYes={generate}>🎲 Draw from table</Confirm>
          {brackets.length > 0 && <Confirm text="Delete the bracket and all unplayed + played playoff fixtures?" onYes={reset}>Reset bracket</Confirm>}
        </div>
      </div>
      {brackets.map((b) => (
        <div key={b.id} className="card">
          <h3>{b.name}</h3>
          <BracketView bracket={b} onSlot={(slot) => setEditSlot({ bracketId: b.id, slot })} />
          <p className="small muted">Click a slot to override its teams or enter the result.</p>
        </div>
      ))}
      {editing && editSlot && (
        <div className="card stack">
          <h3>Slot {editing.slot}</h3>
          <div className="form-grid">
            {(['homeTeamId', 'awayTeamId'] as const).map((side) => (
              <Field key={side} label={side === 'homeTeamId' ? 'Home' : 'Away'}>
                <select className="select" value={editing[side] || ''} disabled={busy} onChange={(e) => setSlotTeam(editSlot.bracketId, editing.slot, side, e.target.value)}>
                  <option value="">TBD</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div className="row">{editing.matchId && <a className="btn" href={`#admin/result?match=${editing.matchId}`}>Enter result</a>}<button className="btn ghost" onClick={() => setEditSlot(null)}>Close</button></div>
        </div>
      )}
      {!brackets.length && <Empty>No bracket yet.</Empty>}
    </>
  );
}

// ======================= Awards =======================
const AWARD_TYPES: { type: string; label: string; recipientType: 'player' | 'team'; leader?: string }[] = [
  { type: 'champion', label: 'League Champions', recipientType: 'team' },
  { type: 'golden_boot', label: 'Golden Boot', recipientType: 'player', leader: 'goals' },
  { type: 'playmaker', label: 'Playmaker', recipientType: 'player', leader: 'assists' },
  { type: 'golden_glove', label: 'Golden Glove', recipientType: 'player', leader: 'saves' },
  { type: 'mvp', label: 'Season MVP', recipientType: 'player', leader: 'mvps' },
  { type: 'custom', label: 'Custom award', recipientType: 'player' },
];

export function AdminAwards() {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: awards } = useCol<Award>(L.seasonId ? `seasons/${L.seasonId}/awards` : null);
  const { data: finals } = useDoc<Bracket>(L.seasonId ? `seasons/${L.seasonId}/playoffs/finals` : null);
  const [f, setF] = useState({ type: 'golden_boot', label: 'Golden Boot', recipientType: 'player' as 'player' | 'team', recipientId: '', value: '' });
  const suggestion = (type: string): { id: string; value: string } | null => {
    const t = AWARD_TYPES.find((x) => x.type === type);
    if (type === 'champion') {
      const fin = finals?.rounds[finals.rounds.length - 1]?.slots[0]?.winnerTeamId;
      const id = fin || L.standings?.rows[0]?.teamId;
      return id ? { id, value: fin ? 'Won the final' : `${L.standings?.rows[0]?.pts} pts` } : null;
    }
    const e = t?.leader ? L.leaders?.categories?.[t.leader]?.[0] : null;
    return e ? { id: e.playerId, value: `${e.value} ${t!.leader}` } : null;
  };
  const sug = suggestion(f.type);
  const grant = () => run(async () => {
    await addDoc(collection(db, `seasons/${L.seasonId}/awards`), {
      ...f, value: f.value || null, suggestedId: sug?.id || null, grantedBy: actor(), grantedAt: serverTimestamp(),
    });
  }, 'Award granted');
  return (
    <>
      <SectionHeader eyebrow={`Season · ${L.season?.name || ''}`} title="Award" accent="trophies" />
      <div className="card stack">
        <div className="form-grid">
          <Field label="Award">
            <select className="select" value={f.type} onChange={(e) => {
              const t = AWARD_TYPES.find((x) => x.type === e.target.value)!;
              setF({ ...f, type: t.type, label: t.label, recipientType: t.recipientType, recipientId: '', value: '' });
            }}>{AWARD_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select>
          </Field>
          <Field label="Label"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
          <Field label="Recipient type"><select className="select" value={f.recipientType} onChange={(e) => setF({ ...f, recipientType: e.target.value as 'player' | 'team', recipientId: '' })}><option value="player">Player</option><option value="team">Team</option></select></Field>
          <Field label="Recipient">
            <select className="select" value={f.recipientId} onChange={(e) => setF({ ...f, recipientId: e.target.value })}>
              <option value="">—</option>
              {(f.recipientType === 'player' ? L.playerList : L.teamList).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          <Field label="Value / note"><input className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
        </div>
        {sug && <div className="row small">💡 Suggested: <b>{f.recipientType === 'player' ? L.players[sug.id]?.name : L.teams[sug.id]?.name}</b> ({sug.value})
          <button className="btn sm" onClick={() => setF({ ...f, recipientId: sug.id, value: sug.value })}>Use suggestion</button></div>}
        <button className="btn primary" disabled={busy || !f.recipientId} onClick={grant}>🏅 Grant award</button>
      </div>
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Award</th><th>Recipient</th><th>Value</th><th /></tr></thead>
          <tbody>{awards.map((a) => (
            <tr key={a.id}><td>{a.label}</td><td>{a.recipientType === 'player' ? L.players[a.recipientId]?.name : L.teams[a.recipientId]?.name}</td><td>{a.value ?? ''}</td>
              <td className="right"><Confirm text="Remove this award?" onYes={() => run(() => deleteDoc(doc(db, `seasons/${L.seasonId}/awards/${a.id}`)), 'Removed')}>✕</Confirm></td></tr>
          ))}</tbody>
        </table>
        {!awards.length && <Empty>No awards granted this season.</Empty>}
      </div>
    </>
  );
}
