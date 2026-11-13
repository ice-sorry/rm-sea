import { useLeague } from '../lib/league';
import { useCol } from '../lib/hooks';
import { PageHeader, SectionHeader, Empty, Crest, TeamChip, Skeleton } from '../components/ui';
import { BracketView, FixtureCard, ResultCard } from '../components/league';
import { cupTeamIds } from '../lib/types';
import type { Cup, MatchDoc } from '../lib/types';

/** #cups (and the old #cup link): every running cup — its name, the teams in it and the bracket — plus the archive. */
export default function CupsPage(_: { mode: 'cups' | 'cup'; sub: string }) {
  const { data: cups, loading } = useCol<Cup>('cups');
  const running = cups.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader eyebrow="Knockout" title="Cups &" accent="silverware" />
      <main className="page">
        <section>
          {loading ? <Skeleton /> : running.length ? <div className="stack">{running.map((c) => <CupView key={c.id} cup={c} />)}</div> : <Empty>No cup is running right now.</Empty>}
        </section>
        <Archive cups={cups} />
      </main>
    </>
  );
}

export function CupTeams({ cup }: { cup: Cup }) {
  const L = useLeague();
  const ids = cupTeamIds(cup);
  if (!ids.length) return null;
  return <div className="row wrap" style={{ gap: 6 }}>{ids.map((t) => <TeamChip key={t} team={L.teams[t]} />)}</div>;
}

export function CupView({ cup }: { cup: Cup }) {
  const L = useLeague();
  const { data: matches } = useCol<MatchDoc>(`cups/${cup.id}/matches`);
  const champ = cup.championTeamId ? L.teams[cup.championTeamId] : null;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>🏆 {cup.name}</h3>
      <CupTeams cup={cup} />
      {champ && <div className="row"><span style={{ fontSize: 28 }}>🏆</span><Crest team={champ} /><b>{champ.name}</b><span className="muted">champions</span></div>}
      <BracketView bracket={cup.bracket} />
      {matches.length > 0 && <div className="card-list two">{[...matches].sort((a, b) => a.round - b.round).map((m) => (m.status === 'played' ? <ResultCard key={m.id} m={m} cupId={cup.id} /> : <FixtureCard key={m.id} m={m} cupId={cup.id} />))}</div>}
    </div>
  );
}

function Archive({ cups }: { cups: Cup[] }) {
  const L = useLeague();
  const archived = cups.filter((c) => c.archived).sort((a, b) => (b.seasonId || '').localeCompare(a.seasonId || ''));
  return (
    <section>
      <SectionHeader eyebrow="History" title="Cup" accent="archive" />
      {!archived.length ? <Empty>No archived cups yet.</Empty> : (
        <div className="stack">
          {archived.map((c) => (
            <details key={c.id} className="card">
              <summary style={{ cursor: 'pointer' }} className="row">
                <b className="grow">{c.name}</b>{c.seasonId && <span className="muted small">{L.seasons.find((s) => s.id === c.seasonId)?.name || c.seasonId}</span>}
                {c.championTeamId && <span className="row small">🏆 <Crest team={L.teams[c.championTeamId]} size="sm" />{L.teams[c.championTeamId]?.name}</span>}
              </summary>
              <div className="stack" style={{ marginTop: 12 }}><CupTeams cup={c} /><BracketView bracket={c.bracket} /></div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
