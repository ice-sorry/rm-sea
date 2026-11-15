import { useMemo, useState } from 'react';
import { useLeague } from '../lib/league';
import { useCol, go } from '../lib/hooks';
import { PageHeader, Tabs, Empty, ExportCard, Crest } from '../components/ui';
import { BracketView, FixtureCard, ResultCard } from '../components/league';
import { fmtDateTime } from '../lib/format';
import type { Bracket, MatchDoc } from '../lib/types';
import { groupBy } from '../lib/types';
import { CalendarDays, Camera, Shield, Trophy } from 'lucide-react';

type Tab = 'fixtures' | 'playoffs';

export default function FixturesPage({ sub }: { sub: string }) {
  const tab: Tab = sub === 'playoffs' ? 'playoffs' : 'fixtures';
  const { season } = useLeague();
  return (
    <>
    <PageHeader eyebrow={season?.name || 'League'} title="Fixtures &" accent="results" />
    <main className="page">
      <section>
        <Tabs tabs={[{ key: 'fixtures', label: 'Fixtures', icon: CalendarDays }, { key: 'playoffs', label: 'Playoffs', icon: Trophy }]} active={tab} onChange={(k) => go(`fixtures/${k}`)} />
        {tab === 'fixtures' ? <FixturesTab /> : <PlayoffsTab />}
      </section>
    </main>
    </>
  );
}

function FixturesTab() {
  const L = useLeague();
  const [team, setTeam] = useState('');
  const [exporting, setExporting] = useState(false);
  const league = L.matches.filter((m) => m.stage === 'league' && (!team || m.homeTeamId === team || m.awayTeamId === team));
  const weeks = useMemo(() => {
    const g = groupBy(league, (m) => String(m.matchweek || 0));
    return Object.entries(g).map(([w, ms]) => ({
      week: Number(w), ms: ms.sort((a, b) => a.round - b.round || (a.kickoffAt?.toMillis() ?? 0) - (b.kickoffAt?.toMillis() ?? 0)),
      done: ms.every((m) => m.status === 'played' || m.status === 'void'),
    }));
  }, [league]);
  const upcoming = weeks.filter((w) => !w.done).sort((a, b) => a.week - b.week);
  const results = weeks.filter((w) => w.done).sort((a, b) => b.week - a.week);
  const Week = ({ w }: { w: { week: number; ms: MatchDoc[] } }) => {
    const rounds = [...new Set(w.ms.map((m) => m.round))];
    return (
      <div>
        <div className="eyebrow" style={{ margin: '12px 0 8px' }}>Matchweek {w.week} · Round{rounds.length > 1 ? 's' : ''} {rounds.join(', ')}</div>
        <div className="card-list two">{w.ms.map((m) => (m.status === 'played' ? <ResultCard key={m.id} m={m} /> : <FixtureCard key={m.id} m={m} />))}</div>
      </div>
    );
  };
  return (
    <div className="stack">
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">All teams</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span className="grow" />
        <button className="btn sm" onClick={() => setExporting(!exporting)}><Camera size={14} aria-hidden />Full schedule</button>
      </div>
      {exporting && <ScheduleExport ms={league} />}
      {!league.length && <Empty>No fixtures yet — the schedule is published once the season launches.</Empty>}
      {upcoming.length > 0 && <div><h3 className="title" style={{ fontSize: 24 }}>Upcoming</h3>{upcoming.map((w) => <Week key={w.week} w={w} />)}</div>}
      {results.length > 0 && <div><h3 className="title" style={{ fontSize: 24 }}>Results</h3>{results.map((w) => <Week key={w.week} w={w} />)}</div>}
    </div>
  );
}

function ScheduleExport({ ms }: { ms: MatchDoc[] }) {
  const L = useLeague();
  const byRound = groupBy([...ms].sort((a, b) => a.round - b.round), (m) => String(m.round));
  return (
    <ExportCard title={`${L.season?.name || ''} Full schedule`} filename={`srl-${L.season?.id || ''}-schedule`}>
      <div style={{ columns: '260px', columnGap: 16 }}>
        {Object.entries(byRound).map(([r, list]) => (
          <div key={r} style={{ breakInside: 'avoid', marginBottom: 12 }}>
            <div className="eyebrow">Round {r}</div>
            {list.map((m) => (
              <div key={m.id} className="row small" style={{ padding: '3px 0' }}>
                <Crest team={L.teams[m.homeTeamId]} size="sm" /><span className="grow ellipsis">{L.teams[m.homeTeamId]?.shortName || L.teams[m.homeTeamId]?.name}</span>
                <b className="num">{m.status === 'played' ? `${m.seriesHome}–${m.seriesAway}` : 'v'}</b>
                <span className="grow ellipsis right">{L.teams[m.awayTeamId]?.shortName || L.teams[m.awayTeamId]?.name}</span><Crest team={L.teams[m.awayTeamId]} size="sm" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </ExportCard>
  );
}

function PlayoffsTab() {
  const L = useLeague();
  const { data: brackets } = useCol<Bracket>(L.seasonId ? `seasons/${L.seasonId}/playoffs` : null);
  const playoffMatches = L.matches.filter((m) => m.stage !== 'league').sort((a, b) => a.round - b.round);
  const finals = brackets.find((b) => b.id === 'finals');
  const others = brackets.filter((b) => b.id !== 'finals');
  return (
    <div className="stack" style={{ gap: 24 }}>
      {!brackets.length && <Empty>The playoff bracket is drawn when the regular season ends.</Empty>}
      {finals && <div className="card"><h3><Trophy size={18} aria-hidden />{finals.name}</h3><BracketView bracket={finals} /></div>}
      {others.map((b) => <div key={b.id} className="card"><h3><Shield size={18} aria-hidden />{b.name}</h3><BracketView bracket={b} /></div>)}
      {playoffMatches.length > 0 && (
        <div>
          <div className="eyebrow">Playoff games</div>
          <div className="card-list two">{playoffMatches.map((m) => (m.status === 'played' ? <ResultCard key={m.id} m={m} /> : <FixtureCard key={m.id} m={m} />))}</div>
          <p className="small muted">Kickoffs shown in your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}). {playoffMatches[0]?.kickoffAt ? `Next: ${fmtDateTime(playoffMatches.find((m) => m.status !== 'played')?.kickoffAt)}` : ''}</p>
        </div>
      )}
    </div>
  );
}
