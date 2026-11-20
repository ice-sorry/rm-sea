import { lazy, Suspense, useEffect, useState } from 'react';
import { LeagueProvider, useLeague } from './lib/league';
import { useHash } from './lib/hooks';
import { ModalProvider, useModal } from './modals/ModalContext';
import { ToastProvider } from './components/ui';
import { MobileNav, TopBar } from './components/Shell';
import { completeDiscordSignIn } from './lib/discordAuth';
import { errMsg } from './lib/format';
import HomePage from './pages/HomePage';
import TablePage from './pages/TablePage';
import StatsPage from './pages/StatsPage';
import FixturesPage from './pages/FixturesPage';
import CupsPage from './pages/CupsPage';
import AwardsPage from './pages/AwardsPage';
import PlayerPage from './pages/PlayerPage';
import TeamPage from './pages/TeamPage';
import TeamsPage from './pages/TeamsPage';
import PlayersPage from './pages/PlayersPage';
import MePage from './pages/MePage';
import RulesPage from './pages/RulesPage';

// Heavy admin panels load on demand.
const AdminPage = lazy(() => import('./admin/AdminPage'));

function AuthCallback() {
  const [error, setError] = useState('');
  useEffect(() => {
    completeDiscordSignIn()
      .then((hash) => location.replace(`/${hash}`))
      .catch((e) => setError(errMsg(e)));
  }, []);
  return (
    <div className="page"><div className="card center">
      {error ? <><p>Sign-in failed: {error}</p><a className="btn" href="/#home">Back to home</a></> : <p>Signing you in with Discord…</p>}
    </div></div>
  );
}

function Routes() {
  const [route, sub, params] = useHash();
  const L = useLeague();
  const { open } = useModal();

  // Deep links: #fixtures?match=<id>. Old #stats?player=<id> / #table?team=<id> links redirect to the pages.
  useEffect(() => {
    const m = params.get('match'), p = params.get('player'), t = params.get('team');
    if (p || t) { location.replace(p ? `#player/${encodeURIComponent(p)}` : `#team/${encodeURIComponent(t!)}`); return; }
    if (m) open({ kind: 'match', id: m.split('/').pop()! });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString()]);

  // New page → start at the top.
  useEffect(() => { window.scrollTo(0, 0); }, [route, sub]);

  // Signed in without a player → straight to player setup (once per session, so they can still browse afterwards).
  useEffect(() => {
    if (!L.authUser || !L.meReady || !L.ready || L.myPlayer || ['me', 'admin'].includes(route)) return;
    if (sessionStorage.getItem('srl_setup_prompted') === L.authUser.uid) return;
    sessionStorage.setItem('srl_setup_prompted', L.authUser.uid);
    location.hash = '#me';
  }, [L.authUser, L.meReady, L.ready, L.myPlayer, route]);

  let page;
  switch (route) {
    case 'table': page = <TablePage sub={sub} />; break;
    case 'stats': page = <StatsPage sub={sub} />; break;
    case 'fixtures': page = <FixturesPage sub={sub} />; break;
    case 'cups': page = <CupsPage mode="cups" sub={sub} />; break;
    case 'cup': page = <CupsPage mode="cup" sub={sub} />; break;
    case 'awards': page = <AwardsPage sub={sub} />; break;
    case 'player': page = <PlayerPage key={sub} id={decodeURIComponent(sub)} />; break;
    case 'teams': page = <TeamsPage />; break;
    case 'players': page = <PlayersPage />; break;
    case 'team': page = <TeamPage key={sub} id={decodeURIComponent(sub)} />; break;
    case 'me': page = <MePage />; break;
    case 'rules': page = <RulesPage />; break;
    case 'admin': page = <Suspense fallback={<div className="page"><div className="empty">Loading admin…</div></div>}><AdminPage sub={sub} /></Suspense>; break;
    default: page = <HomePage />;
  }
  return (
    <div className="app">
      <TopBar route={route} />
      {page}
      <MobileNav route={route} />
    </div>
  );
}

export default function App() {
  if (location.pathname === '/auth/callback') return <ToastProvider><AuthCallback /></ToastProvider>;
  return (
    <ToastProvider>
      <LeagueProvider>
        <ModalProvider>
          <Routes />
        </ModalProvider>
      </LeagueProvider>
    </ToastProvider>
  );
}
