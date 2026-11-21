import { CSSProperties, useMemo, useState } from 'react';
import { collection, serverTimestamp } from 'firebase/firestore';
import { addDoc } from '../lib/db';
import { call, db } from '../lib/firebase';
import { rosterLimit, squadIds, useLeague } from '../lib/league';
import { useAllAwards } from '../lib/cache';
import { PageHeader, Crest, Empty, Skeleton, Field, useAction } from '../components/ui';
import { SignInButton } from '../components/Shell';
import { teamHref } from '../modals/ModalContext';
import { AwardIcon } from '../components/icons';
import { Crown, Lock, Plus, Users } from 'lucide-react';


export default function TeamsPage() {
  const L = useLeague();
  const [creating, setCreating] = useState(false);
  const all = useAllAwards();
  const awards = useMemo(() => all && all.filter((a) => a.recipientType === 'team'), [all]);

  const cap = rosterLimit(L.general);
  const teams = L.teamList.filter((t) => t.active !== false && !t.mergedInto).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader eyebrow={`${teams.length} clubs`} title="Teams"
        right={<button className="btn primary" onClick={() => setCreating(!creating)}><Plus size={16} aria-hidden />Create team</button>} />
      <main className="page">
        {creating && <CreateTeam onDone={() => setCreating(false)} />}
        {!L.ready ? <Skeleton /> : !teams.length ? <Empty>No teams yet.</Empty> : (
          <div className="teams-list">
            {teams.map((t) => {
              const mine = (awards || []).filter((a) => a.recipientId === t.id);
              // Season roster when the club is in the selected season, otherwise the players currently on it.
              const count = squadIds(L, t.id).length;
              const captains = (t.captainIds || []).map((id) => L.players[id]?.name).filter(Boolean);
              return (
                <a key={t.id} className="team-row" href={teamHref(t.id)} style={{ '--team': t.color || 'var(--accent)' } as CSSProperties}>
                  <Crest team={t} size="lg" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="team-name">{t.name}</div>
                    <div className="team-meta">
                      <span><Crown size={16} />{captains.length ? captains.join(', ') : 'No captain'}</span>
                      <span>
                        <Users size={16} />{cap ? `${count} / ${cap} players` : `${count} ${count === 1 ? 'player' : 'players'}`}
                        {cap > 0 && count >= cap && <span className="badge">Full</span>}
                      </span>
                    </div>
                    {mine.length > 0 && (
                      <div className="team-awards">
                        {mine.map((a) => <span key={a.seasonName + a.id} className="badge warn"><AwardIcon type={a.type} />{a.label} · {a.seasonName}</span>)}
                      </div>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

/** Players ask for a new club (an admin approves it and makes them captain). Admins add teams directly in the Admin Panel. */
function CreateTeam({ onDone }: { onDone: () => void }) {
  const L = useLeague();
  const { run, busy } = useAction();
  const [f, setF] = useState({ name: '', shortName: '', color: '#1D8ADE', message: '' });
  const p = L.myPlayer;
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <h3>Create a team</h3>
      {L.isAdmin && <p className="small muted" style={{ margin: 0 }}>As an admin you can add a team straight away in <a href="#admin/teams">Admin → Teams</a>.</p>}
      {!L.authUser ? (
        <><p className="muted" style={{ margin: 0 }}>Sign in with Discord to request a new club.</p><SignInButton big /></>
      ) : !p ? (
        <p className="muted" style={{ margin: 0 }}>Set up your player first. <a href="#me">Set up my player →</a></p>
      ) : L.general.transfersBlocked ? (
        <p className="muted" style={{ margin: 0 }}><Lock size={14} aria-hidden /> Transfers are closed right now, so new clubs can't be requested. Check back when an admin reopens the window.</p>
      ) : (
        <>
          <Field label="Club name"><input className="input" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Abbreviation (≤4)"><input className="input" style={{ width: 110, textTransform: 'uppercase' }} maxLength={4} value={f.shortName} placeholder={f.name.trim().slice(0, 4).toUpperCase()}
            onChange={(e) => setF({ ...f, shortName: e.target.value.replace(/\s+/g, '').toUpperCase().slice(0, 4) })} /></Field>
          <Field label="Colour"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} style={{ width: 80, height: 38 }} /></Field>
          <Field label="Message to the admins (optional)"><input className="input" value={f.message} maxLength={200} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
          <p className="small muted" style={{ margin: 0 }}>An admin reviews the request. Once approved you become the club's captain{p.currentTeamId ? ' and leave your current team' : ''}. The club isn't entered in a season automatically: request to join the current season from its team page.</p>
          <div className="row">
            <button className="btn primary" disabled={busy || f.name.trim().length < 2} onClick={() => run(async () => {
              const ref = await addDoc(collection(db, 'requests'), {
                type: 'new_team', playerId: p.id, fromTeamId: p.currentTeamId, toTeamId: null, seasonId: L.general.currentSeasonId || null,
                status: 'pending', message: f.message, teamName: f.name.trim(), shortName: f.shortName || f.name.trim().slice(0, 4).toUpperCase(), color: f.color, requestedBy: L.authUser!.uid, createdAt: serverTimestamp(),
              });
              // Best effort: a failed Discord post doesn't undo the request.
              await call('notifyRequest')({ requestId: ref.id }).catch(() => undefined);
              onDone();
            }, 'Request sent. Track it on your profile.')}>Request new club</button>
            <button className="btn ghost" onClick={onDone}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
