import { useMemo } from 'react';
import { useLeague } from '../lib/league';
import { useModal } from '../modals/ModalContext';
import { Avatar, Crest, Empty, FormPills, Skeleton, TeamChip, Flag } from './ui';
import { fmtDate, fmtDateTime, signed } from '../lib/format';
import { FEATURES } from '../lib/config';
import type { Bracket, LeaderEntry, MatchDoc, StandingRow, Zone } from '../lib/types';
import { LEADER_CATEGORIES, zoneFor } from '../lib/types';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { LeaderIcon } from './icons';

// ---------- League table ----------
export function LeagueTable({ rows, compact, zones, divisionName }: { rows: StandingRow[] | null; compact?: boolean; zones: Zone[]; divisionName?: string }) {
  const { teams } = useLeague();
  const { open } = useModal();
  if (!rows) return <Skeleton rows={8} />;
  if (!rows.length) return <Empty>There are no teams in the league yet.</Empty>;
  return (
    <div className="table-wrap">
      {divisionName && <div className="eyebrow" style={{ padding: '8px 8px 0' }}>{divisionName}</div>}
      <table className="data">
        <thead>
          <tr>
            <th aria-label="zone" style={{ padding: 0, width: 4 }} />
            <th className="n">#</th><th>Team</th><th className="n">P</th><th className="n">W</th><th className="n">D</th><th className="n">L</th>
            {!compact && <><th className="n">GF</th><th className="n">GA</th><th className="n">GD</th></>}
            <th className="n">Pts</th>
            {!compact && <th>Form</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = teams[r.teamId];
            const z = zoneFor(r.pos, zones);
            return (
              <tr key={r.teamId} className="click" onClick={() => open({ kind: 'team', id: r.teamId })}>
                <td className="zone-cell"><span style={{ background: z?.color || 'transparent' }} title={z?.label} /></td>
                <td className="n muted">{r.pos}</td>
                <td><div className="team-cell"><Crest team={t} size="sm" /><span className="ellipsis" style={{ boxShadow: `inset 0 -2px 0 ${t?.color || 'transparent'}` }}>{t?.name || 'Unknown'}</span></div></td>
                <td className="n">{r.p}</td><td className="n">{r.w}</td><td className="n">{r.d}</td><td className="n">{r.l}</td>
                {!compact && <><td className="n">{r.gf}</td><td className="n">{r.ga}</td><td className="n">{signed(r.gd)}</td></>}
                <td className="n pts">{r.pts}</td>
                {!compact && <td><FormPills form={r.form} /></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ZoneLegend({ zones }: { zones: Zone[] }) {
  return <div className="legend">{zones.map((z) => <span key={`${z.kind}${z.from}`}><i style={{ background: z.color }} />{z.from === z.to ? ordinalRange(z.from) : `${ordinalRange(z.from)}–${ordinalRange(z.to)}`} · {z.label}</span>)}</div>;
}
const ordinalRange = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'}`;

// ---------- Match cards ----------
const stageLabel = (m: MatchDoc) => (m.stage === 'league' ? `Round ${m.round}` : ({ wildcard: 'Wildcard', qf: 'Quarterfinal', sf: 'Semifinal', final: 'Final', cup: 'Cup' } as Record<string, string>)[m.stage] || m.stage);

export function ResultCard({ m, cupId, seasonId }: { m: MatchDoc; cupId?: string; seasonId?: string }) {
  const { teams } = useLeague();
  const { open } = useModal();
  const h = teams[m.homeTeamId], a = teams[m.awayTeamId];
  const hw = m.winnerTeamId === m.homeTeamId, aw = m.winnerTeamId === m.awayTeamId;
  // A gradient in the winner's colour from the winner's side; a draw gets a white one from both sides.
  const glow = hw ? 'won-home' : aw ? 'won-away' : 'drawn';
  const winColor = hw ? h?.color : aw ? a?.color : undefined;
  return (
    <div className={`match-card ${glow}`} style={winColor ? ({ '--win-team': winColor } as React.CSSProperties) : undefined}
      onClick={() => open({ kind: 'match', id: m.id, cupId, seasonId })}>
      <span className="tint" style={{ background: h?.color }} /><span className="tint r" style={{ background: a?.color }} />
      <div className="meta"><span>{stageLabel(m)}</span><span>{fmtDate(m.matchDate || m.kickoffAt)}{m.verification === 'check' && <> · <TriangleAlert size={12} aria-label="Needs a check" /></>}</span></div>
      <div className="teams">
        <div className={`side ${hw ? 'winner' : aw ? 'loser' : ''}`}><Crest team={h} /><span className="ellipsis">{h?.name}</span></div>
        <div className="score num">{m.seriesHome}–{m.seriesAway}</div>
        <div className={`side away ${aw ? 'winner' : hw ? 'loser' : ''}`}><span className="ellipsis">{a?.name}</span><Crest team={a} /></div>
      </div>
      <div className="games num">{(m.games || []).map((g) => <span key={g.n}>{g.homeGoals}–{g.awayGoals}</span>)}</div>
    </div>
  );
}

export function FixtureCard({ m, cupId }: { m: MatchDoc; cupId?: string }) {
  const { teams } = useLeague();
  const { open } = useModal();
  const h = teams[m.homeTeamId], a = teams[m.awayTeamId];
  const live = FEATURES.liveBadge && m.status !== 'played' && m.kickoffAt && Math.abs(Date.now() - m.kickoffAt.toMillis()) < 90 * 60_000 && m.kickoffAt.toMillis() <= Date.now();
  return (
    <div className="match-card" onClick={() => open({ kind: 'match', id: m.id, cupId })}>
      <span className="tint" style={{ background: h?.color }} /><span className="tint r" style={{ background: a?.color }} />
      <div className="meta">
        <span>{stageLabel(m)}</span>
        <span>{live ? <span className="badge live">Live</span> : m.status === 'agreed' ? fmtDateTime(m.kickoffAt) : m.kickoffAt ? fmtDateTime(m.kickoffAt) : 'Kickoff TBC'}</span>
      </div>
      <div className="teams">
        <div className="side"><Crest team={h} /><span className="ellipsis">{h?.name}</span></div>
        <div className="score vs">vs</div>
        <div className="side away"><span className="ellipsis">{a?.name}</span><Crest team={a} /></div>
      </div>
      <div className="games">{m.status === 'agreed' ? <><CircleCheck size={12} aria-hidden /> Time agreed</> : ''}</div>
    </div>
  );
}

// ---------- Leader list ----------
export function LeaderList({ category, entries, limit = 5 }: { category: string; entries?: LeaderEntry[]; limit?: number }) {
  const { players, teams } = useLeague();
  const { open } = useModal();
  const cat = LEADER_CATEGORIES.find((c) => c.key === category);
  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}><LeaderIcon category={cat?.key} />{cat?.label}</h3>
        <button className="btn ghost sm" onClick={() => open({ kind: 'leaderboard', category })}>All →</button>
      </div>
      {!entries?.length ? <Empty>No data yet.</Empty> : entries.slice(0, limit).map((e, i) => {
        const p = players[e.playerId];
        return (
          <div key={e.playerId} className="leader" onClick={() => open({ kind: 'player', id: e.playerId })}>
            <span className="rank">{i + 1}</span>
            <Avatar src={p?.avatarUrl} name={p?.name} />
            <div className="grow"><div className="name ellipsis" style={{ fontWeight: 600 }}>{p?.name || 'Unknown'}<Flag country={p?.country} /></div><TeamChip team={e.teamId ? teams[e.teamId] : null} /></div>
            <span className="value num">{e.value}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Bracket ----------
export function BracketView({ bracket, strip, onSlot }: { bracket: Bracket | null; strip?: boolean; onSlot?: (slotKey: string, matchId: string | null) => void }) {
  const { teams } = useLeague();
  const { open } = useModal();
  if (!bracket?.rounds?.length) return <Empty>Bracket not drawn yet.</Empty>;
  return (
    <div className={strip ? 'bracket-strip' : 'bracket'}>
      {bracket.rounds.map((r) => (
        <div key={r.key} className="bracket-round">
          <h4>{r.label}</h4>
          {r.slots.map((s) => {
            return (
              <div key={s.slot} className="bslot" onClick={() => (onSlot ? onSlot(s.slot, s.matchId) : s.matchId && open({ kind: 'match', id: s.matchId }))}>
                {(['home', 'away'] as const).map((side) => {
                  const id = side === 'home' ? s.homeTeamId : s.awayTeamId;
                  const seed = side === 'home' ? s.homeSeed : s.awaySeed;
                  const cls = s.winnerTeamId ? (s.winnerTeamId === id ? 'won' : 'lost') : '';
                  return (
                    <div key={side} className={`bteam ${cls}`}>
                      <span className="seed">{seed ?? ''}</span>
                      <Crest team={id ? teams[id] : null} size="sm" />
                      <span className="ellipsis">{id ? teams[id]?.name : s.winnerTeamId ? 'Bye' : 'TBD'}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------- Line chart (position tracker / round race) ----------
export function LineChart({ series, maxY, invert, xLabels, height = 280 }: {
  series: { id: string; label: string; color: string; values: (number | null)[] }[];
  maxY: number; invert?: boolean; xLabels: string[]; height?: number;
}) {
  const W = 760, H = height, pad = { l: 28, r: 100, t: 10, b: 24 };
  const n = Math.max(1, xLabels.length - 1);
  const x = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r);
  const y = (v: number) => invert ? pad.t + ((v - 1) / Math.max(1, maxY - 1)) * (H - pad.t - pad.b) : H - pad.b - (v / Math.max(1, maxY)) * (H - pad.t - pad.b);
  const ticks = invert ? Array.from({ length: maxY }, (_, i) => i + 1) : [0, Math.round(maxY / 2), maxY];
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" /><text x={4} y={y(t) + 4}>{t}</text></g>)}
      {xLabels.map((l, i) => <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle">{l}</text>)}
      {series.map((s) => {
        const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)] as const)).filter(Boolean) as (readonly [number, number])[];
        if (!pts.length) return null;
        const last = pts[pts.length - 1];
        return (
          <g key={s.id}>
            <polyline fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" points={pts.map((p) => p.join(',')).join(' ')} />
            {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={s.color} />)}
            <text x={last[0] + 8} y={last[1] + 4} style={{ fill: s.color, fontWeight: 600 }}>{s.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Upcoming + recent helpers shared by pages. */
export function useMatchLists() {
  const { matches } = useLeague();
  return useMemo(() => {
    const played = matches.filter((m) => m.status === 'played').sort((a, b) => (b.matchDate?.toMillis() || 0) - (a.matchDate?.toMillis() || 0) || b.round - a.round);
    const upcoming = matches.filter((m) => m.status === 'scheduled' || m.status === 'agreed')
      .sort((a, b) => (a.kickoffAt?.toMillis() ?? Infinity) - (b.kickoffAt?.toMillis() ?? Infinity) || a.round - b.round);
    return { played, upcoming };
  }, [matches]);
}
