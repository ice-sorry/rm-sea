import { CSSProperties, useEffect, useState } from 'react';
import { collection, getDocs, serverTimestamp } from 'firebase/firestore';
import { addDoc } from '../lib/db';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { PageHeader, Crest, Empty, Skeleton, Field, useAction } from '../components/ui';
import { SignInButton } from '../components/Shell';
import { teamHref } from '../modals/ModalContext';
import type { Award } from '../lib/types';
import { Crown, Users } from 'lucide-react';

const AWARD_EMOJI: Record<string, string> = { champion: '🏆', golden_boot: '👟', playmaker: '🎯', golden_glove: '🧤', mvp: '⭐', custom: '🏅' };

export default function TeamsPage() {
  const L = useLeague();
  const [creating, setCreating] = useState(false);
  const [awards, setAwards] = useState<(Award & { seasonName: string })[] | null>(null);
  useEffect(() => {
    Promise.all(L.seasons.map(async (s) => (await getDocs(collection(db, `seasons/${s.id}/awards`))).docs
      .map((d) => ({ id: d.id, ...d.data(), seasonName: s.name }) as Award & { seasonName: string })))
      .then((x) => setAwards(x.flat().filter((a) => a.recipientType === 'team')))
      .catch(() => setAwards([]));
  }, [L.seasons]);

  const teams = L.teamList.filter((t) => t.active !== false && !t.mergedInto).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader eyebrow={`${teams.length} clubs`} title="Teams"
        right={<button className="btn primary" onClick={() => setCreating(!creating)}>➕ Create team</button>} />
      <main className="page">
        {creating && <CreateTeam onDone={() => setCreating(false)} />}
        {!L.ready ? <Skeleton /> : !teams.length ? <Empty>No teams yet.</Empty> : (
          <div className="teams-list">
            {teams.map((t) => {
              const mine = (awards || []).filter((a) => a.recipientId === t.id);
              // Season roster when the club is in the selected season, otherwise the players currently on it.
              const count = L.rosters[t.id]?.length ?? L.playerList.filter((p) => p.currentTeamId === t.id).length;
              const captains = (t.captainIds || []).map((id) => L.players[id]?.name).filter(Boolean);
              return (
                <a key={t.id} className="team-row" href={teamHref(t.id)} style={{ '--team': t.color || 'var(--accent)' } as CSSProperties}>
                  <Crest team={t} size="lg" />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="team-name">{t.name}</div>
                    <div className="team-meta">
                      <span><Crown size={16} />{captains.length ? captains.join(', ') : 'No captain'}</span>
                      <span><Users size={16} />{count} {count === 1 ? 'player' : 'players'}</span>
                    </div>
                    {mine.length > 0 && (
                      <div className="team-awards">
                        {mine.map((a) => <span key={a.seasonName + a.id} className="badge warn">{AWARD_EMOJI[a.type] || '🏅'} {a.label} · {a.seasonName}</span>)}
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
  const [f, setF] = useState({ name: '', color: '#1D8ADE', message: '' });
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
        <p className="muted" style={{ margin: 0 }}>🔒 Transfers are closed right now, so new clubs can't be requested. Check back when an admin reopens the window.</p>
      ) : (
        <>
          <Field label="Club name"><input className="input" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Colour"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} style={{ width: 80, height: 38 }} /></Field>
          <Field label="Message to the admins (optional)"><input className="input" value={f.message} maxLength={200} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
          <p className="small muted" style={{ margin: 0 }}>An admin reviews the request. Once approved you become the club's captain{p.currentTeamId ? ' and leave your current team' : ''}. The club isn't entered in a season automatically: request to join the current season from its team page.</p>
          <div className="row">
            <button className="btn primary" disabled={busy || f.name.trim().length < 2} onClick={() => run(async () => {
              await addDoc(collection(db, 'requests'), {
                type: 'new_team', playerId: p.id, fromTeamId: p.currentTeamId, toTeamId: null, seasonId: L.general.currentSeasonId || null,
                status: 'pending', message: f.message, teamName: f.name.trim(), color: f.color, requestedBy: L.authUser!.uid, createdAt: serverTimestamp(),
              });
              onDone();
            }, 'Request sent. Track it on your profile.')}>Request new club</button>
            <button className="btn ghost" onClick={onDone}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
