import { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useDoc } from '../lib/hooks';
import { Crest, Avatar, Empty, Skeleton, Flag, useAction } from '../components/ui';
import { KickoffEditor, useCanSetKickoff } from '../components/player';
import { useModal } from './ModalContext';
import { fmtDateTime } from '../lib/format';
import { imageSrc, normalizeImageLink } from '../lib/images';
import type { MatchDoc } from '../lib/types';
import { Camera, Clock, Goal, Star, Wrench } from 'lucide-react';

export default function MatchModal({ id, cupId, seasonId }: { id: string; cupId?: string; seasonId?: string }) {
  const L = useLeague();
  const { open } = useModal();
  const path = cupId ? `cups/${cupId}/matches/${id}` : `seasons/${seasonId || L.seasonId}/matches/${id}`;
  const { data: m, loading } = useDoc<MatchDoc>(path);
  const [shot, setShot] = useState('');
  const { run, busy } = useAction();
  const canKickoff = useCanSetKickoff(m ? [m.homeTeamId, m.awayTeamId] : []);
  if (loading) return <Skeleton rows={6} />;
  if (!m) return <Empty>Match not found.</Empty>;
  const h = L.teams[m.homeTeamId], a = L.teams[m.awayTeamId];
  // Captains of either team (or admins) set the one screenshot per match; a new link replaces the old one.
  const canUpload = canKickoff;
  const name = (pid: string) => L.players[pid]?.name || 'Unknown';
  const screenshot = m.screenshotUrls?.length ? m.screenshotUrls[m.screenshotUrls.length - 1] : null;
  // Free plan: no Cloud Storage, so screenshots are links (e.g. right-click → Copy link on a Discord attachment).
  const addShot = () => run(async () => {
    await updateDoc(doc(db, path), { screenshotUrls: [normalizeImageLink(shot)] });
    setShot('');
  }, screenshot ? 'Screenshot replaced' : 'Screenshot added');
  return (
    <div className="stack">
      <div className="eyebrow center">{m.stage === 'league' ? `Round ${m.round} · Matchweek ${m.matchweek}` : m.stage.toUpperCase()} · {m.status === 'played' ? fmtDateTime(m.matchDate) : fmtDateTime(m.kickoffAt)}</div>
      <div className="match-card" style={{ cursor: 'default' }}>
        <div className="teams">
          <div className="side" style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'team', id: m.homeTeamId })}><Crest team={h} size="lg" /><b>{h?.name}</b></div>
          <div className="score num" style={{ fontSize: 44 }}>{m.status === 'played' ? `${m.seriesHome}–${m.seriesAway}` : 'vs'}</div>
          <div className="side away" style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'team', id: m.awayTeamId })}><b>{a?.name}</b><Crest team={a} size="lg" /></div>
        </div>
        {m.status === 'played' && <div className="center small muted">Goals {m.goalsHome}–{m.goalsAway}{m.verification === 'check' && <span className="badge warn" style={{ marginLeft: 8 }}>Under review</span>}</div>}
      </div>
      {m.mvpPlayerId && <div className="row" style={{ justifyContent: 'center', cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: m.mvpPlayerId! })}><Star size={14} aria-hidden /> MVP <Avatar src={L.players[m.mvpPlayerId]?.avatarUrl} name={name(m.mvpPlayerId)} size="sm" /><b>{name(m.mvpPlayerId)}</b><Flag country={L.players[m.mvpPlayerId]?.country} /></div>}
      {(m.games || []).map((g) => {
        const scorers = Object.entries(g.playerStats || {}).filter(([, s]) => (s.goals || 0) > 0);
        return (
          <div key={g.n} className="card" style={{ padding: 12 }}>
            <div className="row between"><span className="eyebrow" style={{ margin: 0 }}>Game {g.n}{g.sidesSwapped ? ' · sides swapped' : ''}</span><b className="num" style={{ fontSize: 20 }}>{g.homeGoals}–{g.awayGoals}</b></div>
            <div className="grid-2 small" style={{ gap: 4, marginTop: 6 }}>
              <div>{scorers.filter(([, s]) => s.teamId === m.homeTeamId).map(([pid, s]) => <div key={pid} style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: pid })}><Goal size={13} aria-hidden /> {name(pid)}<Flag country={L.players[pid]?.country} />{s.goals! > 1 ? ` ×${s.goals}` : ''}{s.mvp ? <Star size={12} aria-label="MVP" style={{ marginLeft: 4 }} /> : ''}</div>)}</div>
              <div className="right">{scorers.filter(([, s]) => s.teamId === m.awayTeamId).map(([pid, s]) => <div key={pid} style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: pid })}>{s.mvp ? <Star size={12} aria-label="MVP" style={{ marginRight: 4 }} /> : ''}<Flag country={L.players[pid]?.country} /> {name(pid)}{s.goals! > 1 ? ` ×${s.goals}` : ''} <Goal size={13} aria-hidden /></div>)}</div>
            </div>
          </div>
        );
      })}
      {m.status !== 'played' && <p className="center muted">{m.status === 'agreed' ? `Kickoff agreed: ${fmtDateTime(m.kickoffAt)}` : 'Kickoff to be agreed by the captains.'}</p>}
      {m.status !== 'played' && m.status !== 'void' && canKickoff && (
        <div className="card stack" style={{ padding: 12 }}>
          <div className="eyebrow" style={{ margin: 0 }}><Clock size={12} aria-hidden /> Captain: set the kickoff time</div>
          <KickoffEditor m={m} seasonId={cupId ? undefined : seasonId || L.seasonId!} cupId={cupId} />
          <span className="small muted">Times are in your local timezone.</span>
        </div>
      )}
      {screenshot && (
        <a href={imageSrc(screenshot)} target="_blank" rel="noreferrer" className="center"><img src={imageSrc(screenshot)} alt="Match screenshot" style={{ borderRadius: 8, width: '100%', maxWidth: 720 }} loading="lazy" /></a>
      )}
      {canUpload && (
        <div className="row wrap" style={{ justifyContent: 'center' }}>
          <input className="input" style={{ maxWidth: 360 }} placeholder="Screenshot link (Discord attachment or https://…)" value={shot} onChange={(e) => setShot(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shot.trim() && addShot()} />
          <button className="btn sm" disabled={busy || !shot.trim()} onClick={addShot}><Camera size={15} aria-hidden />{screenshot ? 'Replace screenshot' : 'Add screenshot'}</button>
        </div>
      )}
      {L.isAdmin && <div className="row" style={{ justifyContent: 'center' }}><a className="btn sm" href={`#admin/result?${cupId ? `cup=${cupId}&` : ''}match=${id}`}><Wrench size={15} aria-hidden />Edit result</a></div>}
    </div>
  );
}
