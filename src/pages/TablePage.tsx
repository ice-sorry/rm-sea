import { useEffect, useMemo, useState } from 'react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useDoc, go } from '../lib/hooks';
import { PageHeader, Tabs, ExportCard, Empty, Crest, useAction, Skeleton } from '../components/ui';
import { LeagueTable, LineChart, ZoneLegend } from '../components/league';
import { computeStandings, groupBy } from '../lib/types';
import { FEATURES } from '../lib/config';
import type { Game, MatchDoc, StandingRow } from '../lib/types';

type Tab = 'table' | 'tracker' | 'predict';
const TABS: { key: Tab; label: string; emoji: string }[] = [
  { key: 'table', label: 'Table', emoji: '📋' },
  { key: 'tracker', label: 'Position Tracker', emoji: '📈' },
  { key: 'predict', label: 'Predict', emoji: '🔮' },
].filter((t) => t.key !== 'predict' || FEATURES.predictions) as { key: Tab; label: string; emoji: string }[];

export default function TablePage({ sub }: { sub: string }) {
  const tab = (TABS.find((t) => t.key === sub)?.key || 'table') as Tab;
  const { season } = useLeague();
  return (
    <>
    <PageHeader eyebrow={season?.name || 'League'} title="League" accent="table" />
    <main className="page">
      <section>
        <Tabs tabs={TABS} active={tab} onChange={(k) => go(`table/${k}`)} />
        {tab === 'table' && <TableTab />}
        {tab === 'tracker' && <TrackerTab />}
        {tab === 'predict' && FEATURES.predictions && <PredictTab />}
      </section>
    </main>
    </>
  );
}

function DivisionTables({ rows }: { rows: StandingRow[] | null }) {
  const { season } = useLeague();
  if (!rows || !season?.divided) return <LeagueTable rows={rows} zones={season?.zones || []} />;
  const byDiv = groupBy(rows, (r) => r.divisionId || '_');
  return <div className="stack">{Object.entries(byDiv).map(([d, rs]) => (
    <LeagueTable key={d} rows={rs} zones={season.zones} divisionName={season.divisions.find((x) => x.id === d)?.name || 'Division'} />
  ))}</div>;
}

function TableTab() {
  const { standings, season } = useLeague();
  return (
    <ExportCard title={`${season?.name || ''} Standings`} filename={`srl-${season?.id || 'table'}-standings`}>
      <div className="card flush"><DivisionTables rows={standings?.rows ?? (season ? null : [])} /></div>
      <ZoneLegend zones={season?.zones || []} />
    </ExportCard>
  );
}

function TrackerTab() {
  const { standings, teams } = useLeague();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  if (!standings) return <Skeleton />;
  const rounds = Object.keys(standings.byRound || {}).map(Number).sort((a, b) => a - b);
  if (!rounds.length) return <Empty>The tracker fills in after the first round is played.</Empty>;
  const ids = standings.rows.map((r) => r.teamId);
  const series = ids.filter((id) => !hidden.has(id)).map((id) => ({
    id, label: teams[id]?.shortName || teams[id]?.name || id, color: teams[id]?.color || '#888',
    values: rounds.map((r) => { const i = standings.byRound[String(r)].indexOf(id); return i >= 0 ? i + 1 : null; }),
  }));
  return (
    <div className="card">
      <LineChart series={series} maxY={ids.length} invert xLabels={rounds.map((r) => `R${r}`)} height={Math.max(260, ids.length * 28)} />
      <div className="row wrap" style={{ marginTop: 12 }}>
        {ids.map((id) => (
          <button key={id} className="btn sm" style={{ opacity: hidden.has(id) ? 0.4 : 1, borderColor: teams[id]?.color }}
            onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; })}>
            {teams[id]?.shortName || teams[id]?.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Games won by each side; any games left in the fixture (up to `total`) count as draws, since every game earns points. */
const fakeGames = (h: number, a: number, total: number): Game[] => [
  ...Array.from({ length: h }, () => ({ homeGoals: 1, awayGoals: 0 })),
  ...Array.from({ length: a }, () => ({ homeGoals: 0, awayGoals: 1 })),
  ...Array.from({ length: Math.max(0, total - h - a) }, () => ({ homeGoals: 0, awayGoals: 0 })),
].map((g, i) => ({ ...g, n: i + 1 }));

type Pick = { home: number; away: number };
type Draft = { home: string; away: string };
const toNum = (v: string) => (/^\d{1,2}$/.test(v.trim()) ? Number(v) : null);

function PredictTab() {
  const L = useLeague();
  const uid = L.authUser?.uid;
  const { run, busy } = useAction();
  const { data: saved } = useDoc<{ picks: Record<string, Pick> }>(uid && L.seasonId ? `seasons/${L.seasonId}/predictions/${uid}` : null);
  // Inputs hold raw text; a fixture counts as predicted once both sides are whole numbers.
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  useEffect(() => {
    if (saved?.picks) setDraft(Object.fromEntries(Object.entries(saved.picks).map(([id, p]) => [id, { home: String(p.home), away: String(p.away) }])));
  }, [saved]);
  const picks = useMemo(() => {
    const out: Record<string, Pick> = {};
    for (const [id, d] of Object.entries(draft)) {
      const h = toNum(d.home), a = toNum(d.away);
      if (h !== null && a !== null) out[id] = { home: h, away: a };
    }
    return out;
  }, [draft]);
  const remaining = L.matches.filter((m) => m.stage === 'league' && m.status !== 'played' && m.status !== 'void').sort((a, b) => a.round - b.round);
  const simulated = useMemo(() => {
    if (!L.season) return [];
    const ms: MatchDoc[] = L.matches.map((m): MatchDoc => {
      const p = picks[m.id];
      if (m.status === 'played' || !p || m.stage !== 'league') return m;
      return { ...m, status: 'played', games: fakeGames(p.home, p.away, L.season!.seriesFormat?.maxGames ?? 2), seriesHome: p.home, seriesAway: p.away, goalsHome: p.home, goalsAway: p.away,
        winnerTeamId: p.home > p.away ? m.homeTeamId : p.away > p.home ? m.awayTeamId : null };
    });
    return computeStandings(L.season, L.entries, ms, Object.fromEntries(L.teamList.map((t) => [t.id, t.name]))).rows;
  }, [L.season, L.matches, L.entries, L.teamList, picks]);
  const set = (id: string, side: keyof Draft, v: string) =>
    setDraft((d) => ({ ...d, [id]: { home: d[id]?.home ?? '', away: d[id]?.away ?? '', [side]: v.replace(/\D/g, '').slice(0, 2) } }));
  const input = (id: string, side: keyof Draft, label: string) => (
    <input className="input score-input num" inputMode="numeric" aria-label={label} placeholder="–"
      value={draft[id]?.[side] ?? ''} onChange={(e) => set(id, side, e.target.value)} onFocus={(e) => e.target.select()} />
  );
  return (
    <div className="grid-2">
      <div className="card">
        <div className="row between"><h3 style={{ margin: 0 }}>Remaining fixtures</h3>
          <span className="row"><span className="small muted">{Object.keys(picks).length}/{remaining.length} predicted</span>
            <button className="btn sm ghost" onClick={() => setDraft({})}>Reset</button></span></div>
        <p className="small muted">Type the games won by each side. Games not won by either side count as draws (1 point each).</p>
        {!remaining.length && <Empty>No fixtures left to predict.</Empty>}
        {remaining.map((m) => {
          const h = L.teams[m.homeTeamId], a = L.teams[m.awayTeamId];
          return (
            <div key={m.id} className="predict-row">
              <span className="small muted">R{m.round}</span>
              <span className="row home"><span className="ellipsis">{h?.shortName || h?.name}</span><Crest team={h} size="sm" /></span>
              {input(m.id, 'home', `${h?.name} games won`)}
              <span className="muted">–</span>
              {input(m.id, 'away', `${a?.name} games won`)}
              <span className="row"><Crest team={a} size="sm" /><span className="ellipsis">{a?.shortName || a?.name}</span></span>
            </div>
          );
        })}
        {uid ? (
          <button className="btn primary" style={{ marginTop: 12 }} disabled={busy}
            onClick={() => run(() => setDoc(doc(db, `seasons/${L.seasonId}/predictions/${uid}`), { picks, updatedAt: serverTimestamp() }), 'Predictions saved')}>Save predictions</button>
        ) : <p className="small muted">Sign in to save your predictions.</p>}
      </div>
      <div className="card flush">
        <div style={{ padding: 16, paddingBottom: 0 }}><h3>Predicted table</h3></div>
        <LeagueTable rows={simulated} zones={L.season?.zones || []} />
      </div>
    </div>
  );
}
