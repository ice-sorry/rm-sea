import { useEffect, useMemo, useState } from 'react';
import { limit, orderBy } from 'firebase/firestore';
import { useLeague } from '../lib/league';
import { useCol, useDoc } from '../lib/hooks';
import { BRAND, SOCIALS } from '../lib/config';
import { DiscordIcon } from '../components/Shell';
import { SectionHeader, StatCard, Empty, Crest, TeamChip, Avatar, PageHeader, Flag } from '../components/ui';
import { BracketView, FixtureCard, LeagueTable, ResultCard, useMatchLists } from '../components/league';
import { useModal } from '../modals/ModalContext';
import { fmtAgo, fmtDateTime } from '../lib/format';
import type { Award, Bracket, Season, StandingsDoc } from '../lib/types';
import { Trophy } from 'lucide-react';

export default function HomePage() {
  const L = useLeague();
  const { general, season, seasonId } = L;
  if (general.homeMode === 'pinned' && general.pinnedSeasonId) return <PinnedCelebration seasonId={general.pinnedSeasonId} />;
  return (
    <>
      <HomeHero />
      <main className="page home-page">
        {season && (
          <div className="season-heading">
            <h2 className="title">{season.name}</h2>
            <span className={`badge ${season.status === 'live' ? 'ok' : season.status === 'finals' ? 'warn' : ''}`}>{STATUS_LABEL[season.status] || season.status}</span>
          </div>
        )}
        {!season && L.ready && <div className="card center"><h3>Welcome to {BRAND.appName}</h3><p className="muted">No season has been set up yet. Admins: open the Admin Panel → Season to launch one.</p></div>}
        <SeasonCountdown />
        <div className="home-grid">
          <div className="home-main">
            <PlayoffStrip seasonId={seasonId} />
            <SeasonPulse />
            <LatestResults />
            <UpcomingFixtures />
            <TransferNews />
          </div>
          <aside className="home-side">
            <Standings />
          </aside>
        </div>
      </main>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = { draft: 'Coming soon', signups: 'Sign-ups open', live: 'In progress', finals: 'Finals', complete: 'Complete' };

/** Home banner logo (public/home/logo.png). Falls back to the small app icon until that file exists. */
const HOME_LOGO = '/home/logo.png';

/** Centered home banner: logo, league name, a short intro and the Discord invite. */
function HomeHero() {
  return (
    <header className="page-header home-hero">
      <div className="page-header-inner">
        <img src={HOME_LOGO} alt="" className="home-hero-logo" onError={(e) => { if (!e.currentTarget.src.endsWith(BRAND.logo)) e.currentTarget.src = BRAND.logo; }} />
        <h1 className="title">{BRAND.appName.replace(/ League$/, '')} <em>League</em></h1>
        <p className="home-hero-desc">
          The competitive hub for {BRAND.region} {BRAND.game} and the top {BRAND.region} players.
        </p>
        <div className="home-hero-invite">
          <span>Join the community to find a team, meet other players and improve your skills!</span>
          <a className="btn discord" href={SOCIALS.discord} target="_blank" rel="noreferrer"><DiscordIcon />Discord</a>
        </div>
      </div>
    </header>
  );
}

/** Countdown to the current season's start date while it hasn't launched yet (draft / signups). */
export function seasonStartsAt(season: Season | null | undefined): number | null {
  if (!season || !['draft', 'signups'].includes(season.status) || !season.kickoffDate) return null;
  const t = season.kickoffDate.toMillis();
  return t > Date.now() ? t : null;
}

function SeasonCountdown() {
  const L = useLeague();
  const current = L.seasons.find((s) => s.id === L.general.currentSeasonId) || null;
  const [now, setNow] = useState(Date.now());
  const target = seasonStartsAt(current);
  useEffect(() => {
    if (!target) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!current || !target) return null;
  const left = Math.max(0, target - now);
  const parts = [
    [Math.floor(left / 86_400_000), 'days'], [Math.floor(left / 3_600_000) % 24, 'hours'],
    [Math.floor(left / 60_000) % 60, 'minutes'], [Math.floor(left / 1000) % 60, 'seconds'],
  ] as const;
  return (
    <section className="card countdown">
      <div className="eyebrow">{current.status === 'signups' ? 'Sign-ups open' : 'Coming soon'}</div>
      <h3 style={{ margin: 0 }}>{current.name} kicks off in</h3>
      <div className="countdown-grid" role="timer" aria-live="off">
        {parts.map(([v, label]) => <div key={label} className="countdown-cell"><b className="num">{String(v).padStart(2, '0')}</b><span>{label}</span></div>)}
      </div>
      <div className="small muted">{fmtDateTime(current.kickoffDate)}{current.status === 'signups' && <> · <a href="#teams">Find or create a team →</a></>}</div>
    </section>
  );
}

function PlayoffStrip({ seasonId }: { seasonId: string | null }) {
  const { data: finals } = useDoc<Bracket>(seasonId ? `seasons/${seasonId}/playoffs/finals` : null);
  const { season } = useLeague();
  if (!finals || !['finals', 'complete'].includes(season?.status || '')) return null;
  return (
    <section>
      <SectionHeader eyebrow="Finals series" title="Playoff" accent="bracket" link="#fixtures/playoffs" linkLabel="Open full bracket →" />
      <BracketView bracket={finals} strip />
    </section>
  );
}

function SeasonPulse() {
  const L = useLeague();
  const totals = L.leaders?.totals;
  const myTeamId = L.myPlayer?.currentTeamId;
  const next = useMemo(() => myTeamId ? L.matches.filter((m) => (m.homeTeamId === myTeamId || m.awayTeamId === myTeamId) && ['scheduled', 'agreed'].includes(m.status))
    .sort((a, b) => a.round - b.round)[0] : null, [L.matches, myTeamId]);
  const { open } = useModal();
  const roundsPlayed = new Set(L.matches.filter((m) => m.status === 'played' && m.stage === 'league').map((m) => m.round)).size;
  return (
    <section>
      <SectionHeader eyebrow="Season pulse" title="This week in" accent={BRAND.short} />
      <div className="grid-2">
        <div className="stats-row">
          <StatCard value={totals?.series ?? 0} label="series" />
          <StatCard value={totals?.games ?? 0} label="games" />
          <StatCard value={totals?.goals ?? 0} label="goals" />
          <StatCard value={roundsPlayed} label="rounds played" />
        </div>
        <div className="card">
          <h3>Your Next Match</h3>
          {!L.authUser ? <p className="muted">Sign in with Discord to see your next match.</p>
            : !L.myPlayer ? <p className="muted"><a href="#me">Set up your player →</a></p>
              : !myTeamId ? <p className="muted">You're a free agent. <a href="#teams">Request a team →</a></p>
                : next ? (
                  <div onClick={() => open({ kind: 'match', id: next.id })} style={{ cursor: 'pointer' }}>
                    <div className="row" style={{ gap: 12 }}>
                      <Crest team={L.teams[next.homeTeamId]} size="lg" />
                      <div className="grow center">
                        <div className="eyebrow">Round {next.round}</div>
                        <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800 }}>{L.teams[next.homeTeamId]?.shortName} vs {L.teams[next.awayTeamId]?.shortName}</div>
                        <div className="small muted">{fmtDateTime(next.kickoffAt)}</div>
                      </div>
                      <Crest team={L.teams[next.awayTeamId]} size="lg" />
                    </div>
                  </div>
                ) : <p className="muted">No upcoming fixtures for your team.</p>}
        </div>
      </div>
    </section>
  );
}

function LatestResults() {
  const { played } = useMatchLists();
  return (
    <section>
      <SectionHeader eyebrow="Results" title="Latest" accent="action" link="#fixtures" linkLabel="All results →" />
      <div className="card-list auto">{played.length ? played.slice(0, 6).map((m) => <ResultCard key={m.id} m={m} />) : <Empty>No results yet.</Empty>}</div>
    </section>
  );
}

function UpcomingFixtures() {
  const { upcoming } = useMatchLists();
  return (
    <section>
      <SectionHeader eyebrow="Fixtures" title="Next" accent="up" link="#fixtures" linkLabel="All fixtures →" />
      <div className="card-list auto">{upcoming.length ? upcoming.slice(0, 6).map((m) => <FixtureCard key={m.id} m={m} />) : <Empty>Nothing scheduled.</Empty>}</div>
    </section>
  );
}

function TransferNews() {
  const L = useLeague();
  const { open } = useModal();
  const { data: transfers } = useCol<{ playerId: string; fromTeamId: string | null; toTeamId: string; createdAt: { toMillis(): number } }>(
    L.seasonId ? `seasons/${L.seasonId}/transfers` : null, orderBy('createdAt', 'desc'), limit(8));
  return (
    <section>
      <SectionHeader eyebrow="Market" title="Transfer" accent="news" />
      <div className="card">
        {!transfers.length ? <Empty>No moves yet.</Empty> : transfers.map((t) => {
          const p = L.players[t.playerId];
          return (
            <div key={t.id} className="leader" style={{ gridTemplateColumns: '28px 1fr auto' }} onClick={() => open({ kind: 'player', id: t.playerId })}>
              <Avatar src={p?.avatarUrl} name={p?.name} />
              <div className="grow"><div className="name" style={{ fontWeight: 600 }}>{p?.name}<Flag country={p?.country} /></div>
                <div className="row small"><TeamChip team={t.fromTeamId ? L.teams[t.fromTeamId] : null} />→<TeamChip team={L.teams[t.toTeamId]} /></div></div>
              <span className="small muted">{fmtAgo(t.createdAt)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Standings() {
  const L = useLeague();
  return (
    <section>
      <SectionHeader eyebrow="The race" title="League" accent="standings" link="#table" linkLabel="Full table →" />
      <div className="card flush"><LeagueTable compact rows={L.standingsRows} zones={L.season?.zones || []} /></div>
    </section>
  );
}

/** Admin-pinned celebration of a finished season while the next is built. */
function PinnedCelebration({ seasonId }: { seasonId: string }) {
  const L = useLeague();
  const { open } = useModal();
  const { data: standings, loading: standingsLoading } = useDoc<StandingsDoc>(`seasons/${seasonId}/derived/standings`);
  const { data: awards } = useCol<Award>(`seasons/${seasonId}/awards`);
  const season = L.seasons.find((s) => s.id === seasonId);
  const championAward = awards.find((a) => a.type === 'champion');
  const champId = championAward?.recipientId || standings?.rows?.[0]?.teamId;
  const champ = champId ? L.teams[champId] : null;
  return (
    <>
    <PageHeader eyebrow={BRAND.appName} title={season?.name || seasonId} accent="champions" />
    <main className="page">
      <div className="hero-pin">
        <div className="trophy"><Trophy size={64} aria-hidden /></div>
        <div className="eyebrow">{season?.name || seasonId} champions</div>
        <h1 className="title" style={{ fontSize: 56 }}>{champ?.name || 'TBC'}</h1>
        {champ && <div style={{ marginTop: 16 }}><Crest team={champ} size="lg" /></div>}
        <p className="muted">The next season is being built — see you on the pitch.</p>
      </div>
      <section>
        <SectionHeader eyebrow="Season honours" title="Award" accent="winners" link="#awards" />
        <div className="grid-3">
          {awards.filter((a) => a.type !== 'champion').map((a) => (
            <div key={a.id} className="card" style={{ cursor: 'pointer' }} onClick={() => open(a.recipientType === 'player' ? { kind: 'player', id: a.recipientId } : { kind: 'team', id: a.recipientId })}>
              <div className="eyebrow">{a.label}</div>
              <div style={{ fontWeight: 700, fontSize: 18 }}>{a.recipientType === 'player' ? L.players[a.recipientId]?.name : L.teams[a.recipientId]?.name}</div>
              {a.value != null && <div className="muted">{a.value}</div>}
            </div>
          ))}
          {!awards.length && <Empty>Awards to be announced.</Empty>}
        </div>
      </section>
      <section>
        <SectionHeader eyebrow="Final standings" title="The final" accent="table" />
        <div className="card flush"><LeagueTable rows={standings?.rows ?? (standingsLoading ? null : [])} zones={season?.zones || []} /></div>
      </section>
    </main>
    </>
  );
}
