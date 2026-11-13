import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useDoc } from '../lib/hooks';
import { PageHeader, Avatar, Flag, TeamChip, Skeleton, Empty } from '../components/ui';
import { useModal } from '../modals/ModalContext';
import { SortTable, Col } from './StatsPage';
import { STAT_KEYS, STAT_LABELS } from '../lib/types';
import type { Award, Player, PlayerStatRow, RecordsDoc } from '../lib/types';

const AWARD_EMOJI: Record<string, string> = { champion: '🏆', golden_boot: '👟', playmaker: '🎯', golden_glove: '🧤', mvp: '⭐', custom: '🏅' };
type Career = RecordsDoc['career'][string];
interface Row { player: Player; season: PlayerStatRow | null; career: Career | null; awards: (Award & { seasonName: string })[] }

/** #players: every player with this season's and career stats, sortable by any column; awards sit under the name. */
export default function PlayersPage() {
  const L = useLeague();
  const { open } = useModal();
  const { data: records, loading: recLoading } = useDoc<RecordsDoc>('derived/records');
  const [awards, setAwards] = useState<(Award & { seasonName: string })[]>([]);
  const [q, setQ] = useState('');
  const [team, setTeam] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);

  useEffect(() => {
    Promise.all(L.seasons.map(async (s) => (await getDocs(collection(db, `seasons/${s.id}/awards`))).docs
      .map((d) => ({ id: d.id, ...d.data(), seasonName: s.name }) as Award & { seasonName: string })))
      .then((x) => setAwards(x.flat().filter((a) => a.recipientType === 'player')))
      .catch(() => setAwards([]));
  }, [L.seasons]);

  const rows = useMemo<Row[]>(() => {
    const season = new Map((L.playerStats?.rows || []).map((r) => [r.playerId, r]));
    const s = q.trim().toLowerCase();
    return L.playerList
      .filter((p) => !s || p.name.toLowerCase().includes(s))
      .filter((p) => !team || (team === '_fa' ? !p.currentTeamId : p.currentTeamId === team))
      .map((p) => ({ player: p, season: season.get(p.id) || null, career: records?.career?.[p.id] || null, awards: awards.filter((a) => a.recipientId === p.id) }))
      .filter((r) => !onlyActive || (r.season?.gp || 0) > 0);
  }, [L.playerList, L.playerStats, records, awards, q, team, onlyActive]);

  const seasonLabel = L.season?.name || 'This season';
  const cols: Col<Row>[] = [
    {
      key: 'name', label: 'Player', get: (r) => r.player.name,
      render: (r) => (
        <div style={{ minWidth: 180 }}>
          <span className="row"><Avatar src={r.player.avatarUrl} name={r.player.name} size="sm" /><b>{r.player.name}</b><Flag country={r.player.country} /></span>
          {r.awards.length > 0 && (
            <div className="player-awards">{r.awards.map((a) => <span key={a.seasonName + a.id} className="badge warn" title={a.value != null ? String(a.value) : undefined}>{AWARD_EMOJI[a.type] || '🏅'} {a.label} · {a.seasonName}</span>)}</div>
          )}
        </div>
      ),
    },
    { key: 'team', label: 'Team', get: (r) => (r.player.currentTeamId ? L.teams[r.player.currentTeamId]?.name : '') || '', render: (r) => <TeamChip team={r.player.currentTeamId ? L.teams[r.player.currentTeamId] : null} /> },
    { key: 'awards', label: 'Awards', get: (r) => r.awards.length, num: true },
    { key: 's_gp', label: 'Games', group: seasonLabel, get: (r) => r.season?.gp ?? 0, num: true },
    ...STAT_KEYS.map((k): Col<Row> => ({ key: `s_${k}`, label: STAT_LABELS[k], group: seasonLabel, get: (r) => r.season?.[k] ?? 0, num: true })),
    { key: 's_mvps', label: 'MVPs', group: seasonLabel, get: (r) => r.season?.mvps ?? 0, num: true },
    { key: 'c_gp', label: 'Games', group: 'Career', get: (r) => r.career?.gp ?? 0, num: true },
    ...STAT_KEYS.map((k): Col<Row> => ({ key: `c_${k}`, label: STAT_LABELS[k], group: 'Career', get: (r) => r.career?.[k] ?? 0, num: true })),
    { key: 'c_mvps', label: 'MVPs', group: 'Career', get: (r) => r.career?.mvps ?? 0, num: true },
  ];

  return (
    <>
      <PageHeader eyebrow={`${L.playerList.length} players`} title="Players" />
      <main className="page">
        <div className="row wrap" style={{ marginBottom: 'var(--s3)' }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search players…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" style={{ width: 'auto' }} value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option><option value="_fa">Free agents</option>
            {L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <label className="check small"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />Played in {seasonLabel}</label>
          <span className="grow" />
          <span className="small muted">Click a column to sort</span>
        </div>
        {!L.ready || recLoading ? <Skeleton /> : !rows.length ? <Empty>No players match.</Empty> : (
          <div className="card flush">
            <SortTable rows={rows} cols={cols} initial="s_goals" rowKey={(r) => r.player.id} onRow={(r) => open({ kind: 'player', id: r.player.id })} />
          </div>
        )}
      </main>
    </>
  );
}
