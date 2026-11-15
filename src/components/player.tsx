// Player and captain tools that used to live on the #me dashboard. They now sit on the player's own profile,
// the team page and the match screen.
import { useMemo, useState } from 'react';
import { collection, doc, serverTimestamp, where } from 'firebase/firestore';
import { addDoc, updateDoc } from '../lib/db';
import { call, db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useCol, useDoc } from '../lib/hooks';
import { SectionHeader, Empty, Crest, Avatar, Field, Flag, CountrySelect, useAction } from './ui';
import { SignInButton } from './Shell';
import { fmtAgo, fmtDateTime, toLocalInput, ms } from '../lib/format';
import { POSITIONS, POSITION_LABELS } from '../lib/types';
import type { Entry, MatchDoc, Position, RequestDoc } from '../lib/types';

// ---------- Own profile: edit ----------
export function ProfileEditor() {
  const L = useLeague();
  const p = L.myPlayer!;
  const [f, setF] = useState({ name: p.name, position: p.position, bio: p.bio || '', country: p.country || '' });
  const { run, busy } = useAction();
  const [openEd, setOpen] = useState(false);
  if (!openEd) return <button className="btn" onClick={() => setOpen(true)}>✏️ Edit profile</button>;
  return (
    <section className="card stack">
      <h3>Edit profile</h3>
      <div className="form-grid">
        <Field label="Name"><input className="input" value={f.name} maxLength={32} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Position"><select className="select" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value as Position })}>{POSITIONS.map((x) => <option key={x} value={x}>{POSITION_LABELS[x]}</option>)}</select></Field>
        <Field label={<>Country <Flag country={f.country} /></>}><CountrySelect value={f.country} onChange={(country) => setF({ ...f, country })} /></Field>
      </div>
      <Field label="Bio"><textarea className="textarea" style={{ fontFamily: 'inherit', minHeight: 70 }} maxLength={280} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
      <div className="row">
        <button className="btn primary sm" disabled={busy || f.name.trim().length < 2} onClick={() => run(async () => {
          await updateDoc(doc(db, 'players', p.id), { ...f, name: f.name.trim(), nameLower: f.name.trim().toLowerCase(), updatedAt: serverTimestamp() });
          setOpen(false);
        }, 'Profile saved')}>Save</button>
        <button className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </section>
  );
}

// ---------- Own profile: requests ----------
export function MyRequests() {
  const L = useLeague();
  const uid = L.authUser!.uid;
  const { run, busy } = useAction();
  const { data: mine } = useCol<RequestDoc>('requests', where('requestedBy', '==', uid));
  return (
    <section className="card">
      <h3>📨 My requests</h3>
      {!mine.length && <Empty>No requests yet. Open a team's page to ask to join.</Empty>}
      {[...mine].sort((a, b) => ms(b.createdAt) - ms(a.createdAt)).map((r) => (
        <div key={r.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span className="grow small">{requestLabel(r, L.teams[r.teamId || r.toTeamId || '']?.name, L.seasons.find((x) => x.id === r.seasonId)?.name)}<br /><span className="muted">{fmtAgo(r.createdAt)}</span></span>
          <span className={`badge ${r.status === 'accepted' ? 'ok' : r.status === 'pending' ? 'warn' : ''}`}>{r.status}</span>
          {r.status === 'pending' && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('decideRequest')({ requestId: r.id, decision: 'cancel' }), 'Cancelled')}>Cancel</button>}
        </div>
      ))}
      {mine.some((r) => r.status === 'pending') && <p className="small muted">Captains or admins decide team requests; admins decide season requests.</p>}
    </section>
  );
}

export function requestLabel(r: RequestDoc, teamName = '?', seasonName = 'the season') {
  switch (r.type) {
    case 'new_team': return `New club: ${r.teamName}`;
    case 'join_season': return `${teamName} → join ${seasonName}`;
    case 'leave_season': return `${teamName} → leave ${seasonName}`;
    case 'transfer': return `Transfer → ${teamName}`;
    default: return `Join → ${teamName}`;
  }
}

// ---------- Team page: ask to join ----------
export function JoinTeamButton({ teamId }: { teamId: string }) {
  const L = useLeague();
  const p = L.myPlayer;
  const team = L.teams[teamId];
  const { run, busy } = useAction();
  const [openForm, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const { data: mine } = useCol<RequestDoc>(L.authUser ? 'requests' : null, where('requestedBy', '==', L.authUser?.uid || '-'));
  if (team?.active === false) return null;
  if (!L.authUser) return <SignInButton />;
  if (!p) return <a className="btn" href="#me">🙋 Set up my player</a>;
  if (p.currentTeamId === teamId) return null;
  const pending = mine.find((r) => r.status === 'pending' && r.toTeamId === teamId);
  if (pending) return <span className="badge warn" style={{ fontSize: 13, padding: '6px 12px' }}>Request pending</span>;
  if (L.general.transfersBlocked) return <span className="badge" style={{ fontSize: 13, padding: '6px 12px' }} title="An admin has closed the transfer window">🔒 Transfers closed</span>;
  const transfer = !!p.currentTeamId;
  if (!openForm) return <button className="btn primary" onClick={() => setOpen(true)}>{transfer ? '🔁 Request transfer' : '🙋 Request to join'}</button>;
  return (
    <span className="row wrap">
      <input className="input" style={{ maxWidth: 260 }} placeholder="Message to the captain (optional)" value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} />
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        await addDoc(collection(db, 'requests'), {
          type: transfer ? 'transfer' : 'join_team', playerId: p.id, fromTeamId: p.currentTeamId, toTeamId: teamId,
          seasonId: L.general.currentSeasonId || null, status: 'pending', message, requestedBy: L.authUser!.uid, createdAt: serverTimestamp(),
        });
        setOpen(false); setMessage('');
      }, 'Request sent')}>Send</button>
      <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

/** True when the signed-in player captains one of these teams (admins always can). */
export function useCanSetKickoff(teamIds: string[]) {
  const L = useLeague();
  return L.isAdmin || (!!L.myPlayer && teamIds.some((t) => L.teams[t]?.captainIds?.includes(L.myPlayer!.id)));
}

// ---------- Kickoff time (captain tools + match screen) ----------
export function KickoffEditor({ m, seasonId, cupId }: { m: MatchDoc; seasonId?: string; cupId?: string }) {
  const { run, busy } = useAction();
  const [time, setTime] = useState<string | null>(null);
  const value = time ?? toLocalInput(m.kickoffAt);
  return (
    <div className="row wrap">
      <input type="datetime-local" className="input" style={{ maxWidth: 240 }} value={value} onChange={(e) => setTime(e.target.value)} />
      <button className="btn sm primary" disabled={busy || !value}
        onClick={() => run(() => call('agreeKickoff')({ seasonId, cupId, matchId: m.id, kickoffAt: new Date(value).getTime() }), 'Kickoff saved')}>Save time</button>
    </div>
  );
}

// ---------- Team page: captain tools ----------
export function CaptainPanel({ teamId }: { teamId: string }) {
  const L = useLeague();
  const team = L.teams[teamId];
  const { run, busy } = useAction();
  const { data: reqs } = useCol<RequestDoc>('requests', where('toTeamId', '==', teamId), where('status', '==', 'pending'));
  const fixtures = useMemo(() => L.matches.filter((m) => (m.homeTeamId === teamId || m.awayTeamId === teamId) && ['scheduled', 'agreed'].includes(m.status)).sort((a, b) => a.round - b.round).slice(0, 6), [L.matches, teamId]);
  return (
    <section>
      <SectionHeader eyebrow="Captain tools" title={team?.name || 'Team'} accent="HQ" />
      <SeasonEntryCard teamId={teamId} />
      <TeamColorCard teamId={teamId} />
      <div className="grid-2">
        <div className="card">
          <h3>🔔 Join & transfer requests</h3>
          {!reqs.length && <Empty>No pending requests.</Empty>}
          {reqs.map((r) => (
            <div key={r.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <Avatar src={L.players[r.playerId]?.avatarUrl} name={L.players[r.playerId]?.name} size="sm" />
              <span className="grow">{L.players[r.playerId]?.name}<Flag country={L.players[r.playerId]?.country} /><br /><span className="small muted">{r.message || (r.type === 'transfer' ? `from ${L.teams[r.fromTeamId || '']?.name}` : 'free agent')}</span></span>
              <button className="btn sm primary" disabled={busy} onClick={() => run(() => call('decideRequest')({ requestId: r.id, decision: 'accept' }), 'Accepted')}>Accept</button>
              <button className="btn sm" disabled={busy} onClick={() => run(() => call('decideRequest')({ requestId: r.id, decision: 'decline' }), 'Declined')}>Decline</button>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>🕒 Agree kickoff times</h3>
          {!fixtures.length && <Empty>No upcoming fixtures.</Empty>}
          {fixtures.map((m) => (
            <div key={m.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row small"><span className="muted">R{m.round}</span><Crest team={L.teams[m.homeTeamId]} size="sm" />{L.teams[m.homeTeamId]?.shortName} vs {L.teams[m.awayTeamId]?.shortName}<span className="grow" /><span className="muted">{fmtDateTime(m.kickoffAt)}</span></div>
              <div style={{ marginTop: 4 }}><KickoffEditor m={m} seasonId={L.seasonId!} /></div>
            </div>
          ))}
          <p className="small muted">Times are in your local timezone. You can also set them from the match screen.</p>
        </div>
      </div>
    </section>
  );
}

// ---------- Team page: team colour (captains and admins) ----------
function TeamColorCard({ teamId }: { teamId: string }) {
  const L = useLeague();
  const team = L.teams[teamId];
  const { run, busy } = useAction();
  const [color, setColor] = useState<string | null>(null);
  if (!team) return null;
  const current = /^#[0-9a-f]{6}$/i.test(team.color || '') ? team.color : '#1D8ADE';
  const value = color ?? current;
  return (
    <div className="card row wrap" style={{ marginBottom: 'var(--s4)' }}>
      <h3 style={{ margin: 0 }}>🎨 Team colour</h3>
      <input type="color" value={value} onChange={(e) => setColor(e.target.value)} style={{ width: 64, height: 36 }} aria-label="Team colour" />
      <Crest team={{ ...team, color: value }} />
      <span className="grow small muted">Used for the crest, team chips, the teams list and Discord posts.</span>
      <button className="btn sm primary" disabled={busy || value.toLowerCase() === current.toLowerCase()} onClick={() => run(async () => {
        await updateDoc(doc(db, 'teams', teamId), { color: value });
        setColor(null);
      }, 'Team colour saved')}>Save colour</button>
    </div>
  );
}

// ---------- Team page: season entry (captains request, admins decide) ----------
function SeasonEntryCard({ teamId }: { teamId: string }) {
  const L = useLeague();
  const { run, busy } = useAction();
  const team = L.teams[teamId];
  const seasonId = L.general.currentSeasonId || null;
  const season = L.seasons.find((s) => s.id === seasonId);
  const { data: entry, loading } = useDoc<Entry>(seasonId ? `seasons/${seasonId}/entries/${teamId}` : null);
  const { data: reqs } = useCol<RequestDoc>('requests', where('teamId', '==', teamId), where('status', '==', 'pending'));
  const [message, setMessage] = useState('');
  if (!seasonId || !season) return null;
  const entered = !!entry;
  const pending = reqs.find((r) => r.seasonId === seasonId && (r.type === 'join_season' || r.type === 'leave_season'));
  const isCaptain = !!L.myPlayer && !!team?.captainIds?.includes(L.myPlayer.id);
  const closed = season.locked || season.status === 'complete';
  const send = (type: 'join_season' | 'leave_season') => run(async () => {
    await addDoc(collection(db, 'requests'), {
      type, teamId, playerId: L.myPlayer!.id, fromTeamId: null, toTeamId: null, seasonId,
      status: 'pending', message, requestedBy: L.authUser!.uid, createdAt: serverTimestamp(),
    });
    setMessage('');
  }, 'Request sent to the admins');
  return (
    <div className="card stack" style={{ marginBottom: 'var(--s4)' }}>
      <h3>🏟️ {season.name}</h3>
      {loading ? <span className="small muted">Loading…</span> : (
        <span className="small">{entered ? <>✅ {team?.name} is entered{entry?.confirmed === false ? ' (awaiting confirmation)' : ''}.</> : <>{team?.name} is not entered in this season.</>}</span>
      )}
      {pending ? (
        <div className="row wrap">
          <span className="badge warn">{pending.type === 'join_season' ? 'Join' : 'Leave'} request pending</span>
          {pending.requestedBy === L.authUser?.uid && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('decideRequest')({ requestId: pending.id, decision: 'cancel' }), 'Cancelled')}>Cancel</button>}
        </div>
      ) : closed ? (
        <span className="small muted">This season is closed to changes.</span>
      ) : isCaptain && !loading ? (
        <div className="row wrap">
          <input className="input" style={{ maxWidth: 300 }} placeholder="Message to the admins (optional)" value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} />
          {entered
            ? <button className="btn" disabled={busy} onClick={() => send('leave_season')}>🚪 Request to leave</button>
            : <button className="btn primary" disabled={busy} onClick={() => send('join_season')}>🙋 Request to join</button>}
        </div>
      ) : L.isAdmin ? (
        <span className="small muted">Admins add or remove teams under <a href="#admin/season">Admin → Season → Teams &amp; divisions</a>.</span>
      ) : null}
      {isCaptain && !pending && !closed && <span className="small muted">{entered ? 'Leaving needs admin approval; unplayed fixtures are removed and results stay.' : 'An admin reviews the request.'}</span>}
    </div>
  );
}

// ---------- Own profile: season Wrapped ----------
export function WrappedViewer({ slides }: { slides: { kind: string; title: string; value: string | number; caption: string }[] }) {
  const [i, setI] = useState(0);
  const s = slides[i];
  return (
    <section>
      <SectionHeader eyebrow="Season recap" title="Your" accent="Wrapped" />
      <div className="wrapped-slide" onClick={() => setI((i + 1) % slides.length)} style={{ cursor: 'pointer' }}>
        <div className="eyebrow">{i + 1} / {slides.length}</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, textTransform: 'uppercase', fontWeight: 800 }}>{s.title}</div>
        {s.value !== '' && <div className="v">{s.value}</div>}
        <div className="muted">{s.caption}</div>
        <div className="small muted" style={{ marginTop: 24 }}>Tap for next →</div>
      </div>
    </section>
  );
}
