import { useEffect, useMemo, useRef, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useDoc } from '../lib/hooks';
import { Crest, Avatar, Empty, Skeleton, Flag, useAction } from '../components/ui';
import { KickoffEditor, useCanSetKickoff } from '../components/player';
import { useModal } from './ModalContext';
import { fmtDateTime } from '../lib/format';
import { imageSrc, normalizeImageLink } from '../lib/images';
import type { MatchDoc, Team } from '../lib/types';
import type { Game } from '../../core/shared/league';
import { STAT_KEYS, STAT_LABELS } from '../../core/shared/league';
import { Camera, ChevronDown, ChevronRight, Clock, Goal, Star, Wrench } from 'lucide-react';

// The series MVP line is switched off for now; per-game MVPs still show in the tables.
const SHOW_SERIES_MVP = false;

/** "3–1" with the losing side's number dimmed. */
function Score({ home, away }: { home: number; away: number }) {
  return <><span className={home < away ? 'score-lose' : ''}>{home}</span>–<span className={away < home ? 'score-lose' : ''}>{away}</span></>;
}

export default function MatchModal({ id, cupId, seasonId }: { id: string; cupId?: string; seasonId?: string }) {
  const L = useLeague();
  const { open } = useModal();
  const path = cupId ? `cups/${cupId}/matches/${id}` : `seasons/${seasonId || L.seasonId}/matches/${id}`;
  const { data: m, loading } = useDoc<MatchDoc>(path);
  const [shot, setShot] = useState('');
  const [showShot, setShowShot] = useState(false);
  const { run, busy } = useAction();
  const canKickoff = useCanSetKickoff(m ? [m.homeTeamId, m.awayTeamId] : []);
  // The whole popup takes the winning team's colour. The modal shell lives outside this component, so set it there.
  const root = useRef<HTMLDivElement>(null);
  const winColor = m?.status === 'played' && m.winnerTeamId ? L.teams[m.winnerTeamId]?.color : undefined;
  useEffect(() => {
    const modal = root.current?.closest('.modal') as HTMLElement | null;
    if (!modal) return;
    modal.classList.add('match-modal');
    if (winColor) modal.style.setProperty('--win-team', winColor); else modal.style.removeProperty('--win-team');
    return () => { modal.classList.remove('match-modal'); modal.style.removeProperty('--win-team'); };
  }, [winColor, loading]);
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
    <div className="stack match-view" ref={root}>
      <div className="eyebrow center">{m.stage === 'league' ? `Round ${m.round} · Matchweek ${m.matchweek}` : m.stage.toUpperCase()} · {m.status === 'played' ? fmtDateTime(m.matchDate) : fmtDateTime(m.kickoffAt)}</div>
      <div className="match-card" style={{ cursor: 'default' }}>
        <div className="teams">
          <div className="side" style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'team', id: m.homeTeamId })}><Crest team={h} size="lg" /><b>{h?.name}</b></div>
          <div className="score num" style={{ fontSize: 56 }}>{m.status === 'played' ? <Score home={m.seriesHome} away={m.seriesAway} /> : 'vs'}</div>
          <div className="side away" style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'team', id: m.awayTeamId })}><b>{a?.name}</b><Crest team={a} size="lg" /></div>
        </div>
        {m.status === 'played' && <div className="center small muted">Goals {m.goalsHome}–{m.goalsAway}{m.verification === 'check' && <span className="badge warn" style={{ marginLeft: 8 }}>Under review</span>}</div>}
      </div>
      {SHOW_SERIES_MVP && m.mvpPlayerId && <div className="row" style={{ justifyContent: 'center', cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: m.mvpPlayerId! })}><Star size={14} aria-hidden /> MVP <Avatar src={L.players[m.mvpPlayerId]?.avatarUrl} name={name(m.mvpPlayerId)} size="sm" /><b>{name(m.mvpPlayerId)}</b><Flag country={L.players[m.mvpPlayerId]?.country} /></div>}
      {!!m.games?.length && <div className="match-games">{m.games.map((g) => {
        const scorers = Object.entries(g.playerStats || {}).filter(([, s]) => (s.goals || 0) > 0);
        const gameWinner = g.homeGoals > g.awayGoals ? m.homeTeamId : g.awayGoals > g.homeGoals ? m.awayTeamId : null;
        return (
          <div key={g.n} className="card match-game">
            <div className="match-game-head">
              <div className="stack" style={{ gap: 2 }}>
                <span className="eyebrow" style={{ margin: 0 }}>Game {g.n}</span>
                {g.sidesSwapped && <span className="small muted">sides swapped</span>}
              </div>
              <div className="game-score-col">
                <b className="num game-score"><Score home={g.homeGoals} away={g.awayGoals} /></b>
                {gameWinner
                  ? <span className="game-result" style={{ '--team': L.teams[gameWinner]?.color || 'var(--accent)' } as React.CSSProperties}>{L.teams[gameWinner]?.name || 'Winner'} won</span>
                  : <span className="game-result draw">Draw</span>}
              </div>
              <span />
            </div>
            <div className="grid-2 small" style={{ gap: 4, marginTop: 6 }}>
              <div>{scorers.filter(([, s]) => s.teamId === m.homeTeamId).map(([pid, s]) => <div key={pid} style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: pid })}><Goal size={13} aria-hidden /> {name(pid)}<Flag country={L.players[pid]?.country} />{s.goals! > 1 ? ` ×${s.goals}` : ''}{s.mvp ? <Star size={12} aria-label="MVP" style={{ marginLeft: 4 }} /> : ''}</div>)}</div>
              <div className="right">{scorers.filter(([, s]) => s.teamId === m.awayTeamId).map(([pid, s]) => <div key={pid} style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: pid })}>{s.mvp ? <Star size={12} aria-label="MVP" style={{ marginRight: 4 }} /> : ''}<Flag country={L.players[pid]?.country} /> {name(pid)}{s.goals! > 1 ? ` ×${s.goals}` : ''} <Goal size={13} aria-hidden /></div>)}</div>
            </div>
            {m.status === 'played' && (
              <div className="match-team-stats">
                <TeamStatsTable game={g} team={h} teamId={m.homeTeamId} name={name} />
                <TeamStatsTable game={g} team={a} teamId={m.awayTeamId} away name={name} />
              </div>
            )}
          </div>
        );
      })}</div>}
      {m.status !== 'played' && <p className="center muted">{m.status === 'agreed' ? `Kickoff agreed: ${fmtDateTime(m.kickoffAt)}` : 'Kickoff to be agreed by the captains.'}</p>}
      {m.status !== 'played' && m.status !== 'void' && canKickoff && (
        <div className="card stack" style={{ padding: 12 }}>
          <div className="eyebrow" style={{ margin: 0 }}><Clock size={12} aria-hidden /> Captain: set the kickoff time</div>
          <KickoffEditor m={m} seasonId={cupId ? undefined : seasonId || L.seasonId!} cupId={cupId} />
          <span className="small muted">Times are in your local timezone.</span>
        </div>
      )}
      {screenshot && (
        <div className="stack" style={{ gap: 'var(--s2)' }}>
          <button className="btn ghost shot-toggle" aria-expanded={showShot} onClick={() => setShowShot((v) => !v)}>
            {showShot ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}{showShot ? 'Hide screenshot' : 'Show screenshot'}
          </button>
          {showShot && <a href={imageSrc(screenshot)} target="_blank" rel="noreferrer" className="center"><img className="match-shot" src={imageSrc(screenshot)} alt="Match screenshot" loading="lazy" /></a>}
        </div>
      )}
      {canUpload && (
        <div className="card stack" style={{ padding: 12 }}>
          <div className="eyebrow" style={{ margin: 0 }}><Camera size={12} aria-hidden /> Captain: match screenshot</div>
          <div className="row wrap">
            <input className="input" style={{ maxWidth: 360 }} placeholder="https://cdn.discordapp.com/attachments/…" value={shot} onChange={(e) => setShot(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shot.trim() && addShot()} />
            <button className="btn sm" disabled={busy || !shot.trim()} onClick={addShot}><Camera size={15} aria-hidden />{screenshot ? 'Replace screenshot' : 'Add screenshot'}</button>
          </div>
          <div className="small muted">
            <b>How to add the screenshot</b>
            <ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              <li>Find this match's post in <b>#fixture-hub</b> on Discord.</li>
              <li>Post the end-of-series screenshot there.</li>
              <li>Right-click the image → <b>Copy Image Link</b>.</li>
              <li>Paste the link into the box above and press <b>{screenshot ? 'Replace screenshot' : 'Add screenshot'}</b>.</li>
            </ol>
            One screenshot per match; adding a new one replaces the old.
          </div>
        </div>
      )}
      {L.isAdmin && <div className="row" style={{ justifyContent: 'center' }}><a className="btn sm" href={`#admin/result?${cupId ? `cup=${cupId}&` : ''}match=${id}`}><Wrench size={15} aria-hidden />Edit result</a></div>}
    </div>
  );
}

/** One team's stats for a single game: the players ticked as "played" in that game (same stats as the result editor). */
function TeamStatsTable({ game, team, teamId, away, name }: { game: Game; team?: Team; teamId: string; away?: boolean; name: (pid: string) => string }) {
  const { open } = useModal();
  const rows = useMemo(() => Object.entries(game.playerStats || {})
    .filter(([, st]) => st.teamId === teamId)
    .sort(([pa, a], [pb, b]) => ((b.goals || 0) - (a.goals || 0)) || ((b.assists || 0) - (a.assists || 0)) || name(pa).localeCompare(name(pb))),
  [game, teamId, name]);
  return (
    <div className={`card flush team-stats-card${away ? ' away' : ''}`} style={{ '--team': team?.color || 'var(--accent)' } as React.CSSProperties}>
      <div className="team-stats-head"><Crest team={team} size="sm" /><b>{team?.name || 'Team'}</b></div>
      {!rows.length ? <div className="small muted" style={{ padding: 'var(--s3) var(--s4)' }}>No player stats entered.</div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Player</th>{STAT_KEYS.map((k) => <th key={k} className="n">{STAT_LABELS[k]}</th>)}<th className="n">MVP</th></tr></thead>
            <tbody>{rows.map(([pid, st]) => (
              <tr key={pid} style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: pid })}>
                <td><b>{name(pid)}</b></td>
                {STAT_KEYS.map((k) => <td key={k} className="n">{st[k] || 0}</td>)}
                <td className="n">{st.mvp ? <Star size={13} aria-label="MVP" /> : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
