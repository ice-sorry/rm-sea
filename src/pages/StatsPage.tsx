import { ReactNode, useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useDoc, go } from '../lib/hooks';
import { PageHeader, Tabs, Empty, Crest, TeamChip, Avatar, Skeleton, Flag } from '../components/ui';
import { LeaderList, LineChart, ResultCard } from '../components/league';
import { useModal } from '../modals/ModalContext';
import { pct, signed } from '../lib/format';
import { LEADER_CATEGORIES, STAT_KEYS, STAT_LABELS, gamePoints } from '../lib/types';
import type { MatchDoc, PlayerStatRow, RecordsDoc, TeamStatRow } from '../lib/types';

type Tab = 'overview' | 'players' | 'teams' | 'h2h';
const TABS: { key: Tab; label: string; emoji: string }[] = [
  { key: 'overview', label: 'Overview', emoji: '✨' },
  { key: 'players', label: 'Players', emoji: '👤' },
  { key: 'teams', label: 'Teams', emoji: '🛡️' },
  { key: 'h2h', label: 'H2H', emoji: '⚖️' },
];

export default function StatsPage({ sub }: { sub: string }) {
  const tab = (TABS.find((t) => t.key === sub)?.key || 'overview') as Tab;
  const { season } = useLeague();
  return (
    <>
    <PageHeader eyebrow={season?.name || 'League'} title="The" accent="numbers" />
    <main className="page">
      <section>
        <Tabs tabs={TABS} active={tab} onChange={(k) => go(`stats/${k}`)} />
        {tab === 'overview' && <Overview />}
        {tab === 'players' && <PlayersTab />}
        {tab === 'teams' && <TeamsTab />}
        {tab === 'h2h' && <H2HTab />}
      </section>
    </main>
    </>
  );
}

// ---------- Sortable table ----------
export interface Col<T> { key: string; label: string; get: (r: T) => number | string | null; render?: (r: T) => ReactNode; num?: boolean; group?: string }
export function SortTable<T>({ rows, cols, initial, initialDir = -1, onRow, rowKey }: { rows: T[]; cols: Col<T>[]; initial: string; initialDir?: 1 | -1; onRow?: (r: T) => void; rowKey: (r: T) => string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: initial, dir: initialDir });
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (typeof x === 'number' || typeof y === 'number') return ((Number(x ?? -Infinity)) - Number(y ?? -Infinity)) * sort.dir;
    return String(x ?? '').localeCompare(String(y ?? '')) * sort.dir;
  });
  // Optional grouped header row: consecutive columns sharing a `group` get one spanning cell.
  const groups: { label: string; span: number }[] = [];
  for (const c of cols) {
    const last = groups[groups.length - 1];
    if (last && last.label === (c.group || '')) last.span++; else groups.push({ label: c.group || '', span: 1 });
  }
  const grouped = cols.some((c) => c.group);
  return (
    <div className="table-wrap" style={{ maxHeight: '70vh' }}>
      <table className="data">
        <thead>
          {grouped && <tr className="group-row"><th />{groups.map((g, i) => <th key={i} colSpan={g.span} className={g.label ? 'group' : ''}>{g.label}</th>)}</tr>}
          <tr><th>#</th>{cols.map((c) => (
          <th key={c.key} className={`sortable ${c.num ? 'n' : ''}`} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : -1 }))}>
            {c.label}{sort.key === c.key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
          </th>))}</tr>
        </thead>
        <tbody>{sorted.map((r, i) => (
          <tr key={rowKey(r)} className={onRow ? 'click' : ''} onClick={() => onRow?.(r)}>
            <td className="muted">{i + 1}</td>
            {cols.map((c) => <td key={c.key} className={c.num ? 'n' : ''}>{c.render ? c.render(r) : c.get(r) ?? '—'}</td>)}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

function usePlayerCols(): Col<PlayerStatRow>[] {
  const { players, teams } = useLeague();
  return [
    { key: 'name', label: 'Player', get: (r) => players[r.playerId]?.name || '', render: (r) => <span className="row"><Avatar src={players[r.playerId]?.avatarUrl} name={players[r.playerId]?.name} size="sm" />{players[r.playerId]?.name || 'Unknown'}<Flag country={players[r.playerId]?.country} /></span> },
    { key: 'team', label: 'Team', get: (r) => (r.teamId ? teams[r.teamId]?.name : '') || '', render: (r) => <TeamChip team={r.teamId ? teams[r.teamId] : null} /> },
    { key: 'gp', label: 'GP', get: (r) => r.gp, num: true },
    ...STAT_KEYS.map((k): Col<PlayerStatRow> => ({ key: k, label: STAT_LABELS[k], get: (r) => r[k] ?? 0, num: true })),
    { key: 'mvps', label: 'MVPs', get: (r) => r.mvps, num: true },
    { key: 'winRate', label: 'Win%', get: (r) => r.adv.winRate, render: (r) => pct(r.adv.winRate), num: true },
  ];
}

// ---------- Overview ----------
function Overview() {
  const L = useLeague();
  const { data: records } = useDoc<RecordsDoc>('derived/records');
  const rows = L.playerStats?.rows || [];
  const minGp = Math.max(3, Math.floor(Math.max(0, ...rows.map((r) => r.gp)) / 3));
  const qualified = rows.filter((r) => r.gp >= minGp);
  const { open } = useModal();
  const pcols = usePlayerCols();

  // Round-by-round race: cumulative points per team.
  const race = useMemo(() => {
    const lm = L.matches.filter((m) => m.stage === 'league' && m.status === 'played');
    const rounds = [...new Set(lm.map((m) => m.round))].sort((a, b) => a - b);
    const sc = L.season?.scoring || { win: 3, draw: 1, loss: 0 };
    const top = (L.standings?.rows || []).slice(0, 8).map((r) => r.teamId);
    let maxY = 0;
    const series = top.map((t) => {
      let acc = 0;
      const values = rounds.map((r) => {
        for (const m of lm.filter((x) => x.round === r && (x.homeTeamId === t || x.awayTeamId === t)))
          acc += gamePoints(m, t, sc);
        maxY = Math.max(maxY, acc);
        return acc;
      });
      return { id: t, label: L.teams[t]?.shortName || '', color: L.teams[t]?.color || '#888', values };
    });
    return { rounds, series, maxY };
  }, [L.matches, L.standings, L.season, L.teams]);

  // Record watch: current-season players chasing all-time single-season records.
  const watch = useMemo(() => {
    const keys: [string, keyof PlayerStatRow][] = [['season_goals', 'goals'], ['season_assists', 'assists'], ['season_saves', 'saves'], ['season_mvps', 'mvps'], ['season_interceptions', 'interceptions']];
    return keys.map(([rk, sk]) => {
      const rec = records?.records.find((r) => r.key === rk);
      const best = [...rows].sort((a, b) => Number(b[sk]) - Number(a[sk]))[0];
      if (!rec || !best) return null;
      return { label: rec.label, record: rec.value, holder: rec.holderId, holderSeason: rec.seasonId, chaser: best.playerId, value: Number(best[sk]) };
    }).filter(Boolean) as { label: string; record: number; holder: string; holderSeason: string | null; chaser: string; value: number }[];
  }, [records, rows]);

  const perGame = (k: 'goals' | 'assists' | 'saves' | 'interceptions') => [...qualified].sort((a, b) => b.perGame[k] - a.perGame[k]).slice(0, 5);
  return (
    <div className="stack" style={{ gap: 32 }}>
      <div className="grid-3">
        {LEADER_CATEGORIES.slice(0, 6).map((c) => <LeaderList key={c.key} category={c.key} entries={L.leaders?.categories?.[c.key]} />)}
      </div>
      <div className="card">
        <h3>📈 Round-by-round race</h3>
        {race.rounds.length ? <LineChart series={race.series} maxY={race.maxY} xLabels={race.rounds.map((r) => `R${r}`)} /> : <Empty>No rounds played yet.</Empty>}
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>🎯 Record Watch</h3>
          {!watch.length ? <Empty>Records appear after the first results.</Empty> : watch.map((w) => (
            <div key={w.label} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: w.chaser })}>
              <div className="row between small"><span className="muted">{w.label}</span><span>Record: <b>{w.record}</b> · {L.players[w.holder]?.name}{w.holderSeason ? ` (${w.holderSeason})` : ''}</span></div>
              <div className="row between"><b>{L.players[w.chaser]?.name}<Flag country={L.players[w.chaser]?.country} /></b><span className="num">{w.value} / {w.record}</span></div>
              <div className="progress"><i style={{ width: `${Math.min(100, (w.value / Math.max(1, w.record)) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>⚖️ Per-game scaled <span className="small muted">(min {minGp} games)</span></h3>
          {(['goals', 'assists', 'interceptions', 'saves'] as const).map((k) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <div className="eyebrow">{STAT_LABELS[k]} per game</div>
              {perGame(k).map((r) => <div key={r.playerId} className="row between small" style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: r.playerId })}><span>{L.players[r.playerId]?.name}<Flag country={L.players[r.playerId]?.country} /></span><b className="num">{r.perGame[k].toFixed(2)}</b></div>)}
              {!perGame(k).length && <div className="small muted">—</div>}
            </div>
          ))}
        </div>
      </div>
      <div className="card flush">
        <div style={{ padding: 16, paddingBottom: 0 }}><h3>🧠 Advanced metrics</h3></div>
        <SortTable rows={qualified} initial="contrib" rowKey={(r) => r.playerId} onRow={(r) => open({ kind: 'player', id: r.playerId })} cols={[
          pcols[0],
          { key: 'contrib', label: 'G+A / game', get: (r) => r.adv.contribPg, num: true },
          { key: 'winRate', label: 'Win rate', get: (r) => r.adv.winRate, render: (r) => pct(r.adv.winRate), num: true },
          { key: 'mvpRate', label: 'MVP / series', get: (r) => r.adv.mvpRate, num: true },
        ]} />
      </div>
      <div className="card flush"><div style={{ padding: 16, paddingBottom: 0 }}><h3>🛡️ Team stats</h3></div><TeamsTable compact /></div>
      <div className="row"><a className="btn" href="#stats/players">Full player stats →</a><a className="btn" href="#stats/teams">Full team stats →</a></div>
    </div>
  );
}

function PlayersTab() {
  const L = useLeague();
  const { open } = useModal();
  const cols = usePlayerCols();
  const [picked, setPicked] = useState<string[]>([]);
  const [team, setTeam] = useState('');
  if (!L.playerStats) return <Skeleton />;
  const rows = L.playerStats.rows.filter((r) => !team || r.teamId === team);
  return (
    <div className="stack">
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">All teams</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span className="grow" />
        <span className="small muted">{picked.length ? `${picked.length} selected` : 'Tick players to compare'}</span>
        <button className="btn sm primary" disabled={picked.length < 2} onClick={() => open({ kind: 'compare', ids: picked })}>Compare</button>
      </div>
      <div className="card flush">
        <SortTable rows={rows} initial="goals" rowKey={(r) => r.playerId} onRow={(r) => open({ kind: 'player', id: r.playerId })}
          cols={[{ key: 'pick', label: '✓', get: () => null, render: (r) => <input type="checkbox" checked={picked.includes(r.playerId)} onClick={(e) => e.stopPropagation()}
            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.playerId] : p.filter((x) => x !== r.playerId)))} /> }, ...cols]} />
      </div>
    </div>
  );
}

/** Team stats table. `compact` (Statistics → Overview) shows only the headline columns. */
function TeamsTable({ compact }: { compact?: boolean }) {
  const L = useLeague();
  const { open } = useModal();
  if (!L.teamStats) return <Skeleton />;
  const team: Col<TeamStatRow> = { key: 'team', label: 'Team', get: (r) => L.teams[r.teamId]?.name || '', render: (r) => <span className="team-cell"><Crest team={L.teams[r.teamId]} size="sm" />{L.teams[r.teamId]?.name}</span> };
  if (compact) {
    return (
      <SortTable rows={L.teamStats.rows} initial="gd" rowKey={(r) => r.teamId} onRow={(r) => open({ kind: 'team', id: r.teamId })} cols={[
        team,
        { key: 'games', label: 'Games played', get: (r) => r.games, num: true },
        { key: 'goalsPg', label: 'Goals / game', get: (r) => r.goalsPg, render: (r) => r.goalsPg.toFixed(2), num: true },
        { key: 'concededPg', label: 'Goals against / game', get: (r) => r.concededPg, render: (r) => r.concededPg.toFixed(2), num: true },
        { key: 'gd', label: 'Goal difference', get: (r) => r.gf - r.ga, render: (r) => signed(r.gf - r.ga), num: true },
        { key: 'cleanSheets', label: 'Clean sheets', get: (r) => r.cleanSheets, num: true },
      ]} />
    );
  }
  return (
    <SortTable rows={L.teamStats.rows} initial="gf" rowKey={(r) => r.teamId} onRow={(r) => open({ kind: 'team', id: r.teamId })} cols={[
      team,
      { key: 'series', label: 'Series', get: (r) => r.series, num: true },
      { key: 'games', label: 'Games', get: (r) => r.games, num: true },
      { key: 'gw', label: 'GW', get: (r) => r.gw, num: true },
      { key: 'gl', label: 'GL', get: (r) => r.gl, num: true },
      { key: 'gf', label: 'GF', get: (r) => r.gf, num: true },
      { key: 'ga', label: 'GA', get: (r) => r.ga, num: true },
      { key: 'goalsPg', label: 'GF/g', get: (r) => r.goalsPg, num: true },
      { key: 'concededPg', label: 'GA/g', get: (r) => r.concededPg, num: true },
      { key: 'cleanSheets', label: 'CS', get: (r) => r.cleanSheets, num: true },
      { key: 'interceptions', label: 'Interceptions', get: (r) => r.interceptions ?? 0, num: true },
      { key: 'passes', label: 'Passes', get: (r) => r.passes ?? 0, num: true },
      { key: 'saves', label: 'Saves', get: (r) => r.saves ?? 0, num: true },
    ]} />
  );
}
const TeamsTab = () => <div className="card flush"><TeamsTable /></div>;

function H2HTab() {
  const L = useLeague();
  const [a, setA] = useState(''), [b, setB] = useState('');
  const [all, setAll] = useState<(MatchDoc & { seasonId: string })[] | null>(null);
  useEffect(() => {
    if (!a || !b || all) return;
    Promise.all(L.seasons.map(async (s) => (await getDocs(collection(db, `seasons/${s.id}/matches`))).docs.map((d) => ({ id: d.id, seasonId: s.id, ...d.data() }) as MatchDoc & { seasonId: string })))
      .then((x) => setAll(x.flat()));
  }, [a, b, all, L.seasons]);
  const games = (all || []).filter((m) => m.status === 'played' && [m.homeTeamId, m.awayTeamId].includes(a) && [m.homeTeamId, m.awayTeamId].includes(b));
  const wa = games.filter((m) => m.winnerTeamId === a).length, wb = games.filter((m) => m.winnerTeamId === b).length;
  const pick = (v: string, set: (s: string) => void) => (
    <select className="select" value={v} onChange={(e) => set(e.target.value)}><option value="">Pick a team…</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
  );
  return (
    <div className="stack">
      <div className="grid-2">{pick(a, setA)}{pick(b, setB)}</div>
      {a && b && a !== b && (
        !all ? <Skeleton /> : (
          <>
            <div className="stats-row">
              <div className="stat-card center"><Crest team={L.teams[a]} size="lg" /><div className="big">{wa}</div><div className="label">{L.teams[a]?.shortName} wins</div></div>
              <div className="stat-card center"><div className="big">{games.length - wa - wb}</div><div className="label">draws</div></div>
              <div className="stat-card center"><Crest team={L.teams[b]} size="lg" /><div className="big">{wb}</div><div className="label">{L.teams[b]?.shortName} wins</div></div>
            </div>
            <div className="card-list two">{games.map((m) => <ResultCard key={m.seasonId + m.id} m={m} seasonId={m.seasonId} />)}</div>
            {!games.length && <Empty>These teams have never met.</Empty>}
          </>
        )
      )}
    </div>
  );
}
