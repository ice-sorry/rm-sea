import { useMemo, useState } from 'react';
import { useLeague } from '../lib/league';
import { loadPlayerStats, useCached } from '../lib/cache';
import { useDoc } from '../lib/hooks';
import { Avatar, TeamChip, Tabs, Flag } from '../components/ui';
import { pct } from '../lib/format';
import type { PlayerStatRow, RecordsDoc } from '../lib/types';

type Scope = string; // seasonId or 'all'

export default function CompareModal({ initial }: { initial: string[] }) {
  const L = useLeague();
  const [ids, setIds] = useState<string[]>(initial);
  const [scope, setScope] = useState<Scope>(L.seasonId || 'all');
  const { data: records } = useDoc<RecordsDoc>('derived/records');
  // The selected season's rows come from the live league data; other seasons are read once per session.
  const ttl = L.isAdmin ? 0 : undefined;
  const other = useCached(scope !== 'all' && scope !== L.seasonId ? `playerStats|${scope}` : null, () => loadPlayerStats(scope, ttl), ttl);
  const rows = useMemo<Record<string, PlayerStatRow>>(() => Object.fromEntries(
    ((scope === L.seasonId ? L.playerStats?.rows : other) || []).map((r) => [r.playerId, r])), [scope, L.seasonId, L.playerStats, other]);
  const metrics: { label: string; get: (id: string) => number | null; fmt?: (n: number | null) => string }[] = scope === 'all'
    ? [
      { label: 'Games', get: (id) => records?.career?.[id]?.gp ?? 0 },
      { label: 'Goals', get: (id) => records?.career?.[id]?.goals ?? 0 },
      { label: 'Assists', get: (id) => records?.career?.[id]?.assists ?? 0 },
      { label: 'Interceptions', get: (id) => records?.career?.[id]?.interceptions ?? 0 },
      { label: 'Passes', get: (id) => records?.career?.[id]?.passes ?? 0 },
      { label: 'Saves', get: (id) => records?.career?.[id]?.saves ?? 0 },
      { label: 'MVPs', get: (id) => records?.career?.[id]?.mvps ?? 0 },
    ]
    : [
      { label: 'Games', get: (id) => rows[id]?.gp ?? 0 },
      { label: 'Goals', get: (id) => rows[id]?.goals ?? 0 },
      { label: 'Assists', get: (id) => rows[id]?.assists ?? 0 },
      { label: 'Interceptions', get: (id) => rows[id]?.interceptions ?? 0 },
      { label: 'Passes', get: (id) => rows[id]?.passes ?? 0 },
      { label: 'Saves', get: (id) => rows[id]?.saves ?? 0 },
      { label: 'MVPs', get: (id) => rows[id]?.mvps ?? 0 },
      { label: 'Goals / game', get: (id) => rows[id]?.perGame.goals ?? 0 },
      { label: 'G+A / game', get: (id) => rows[id]?.adv.contribPg ?? 0 },
      { label: 'Win rate', get: (id) => rows[id]?.adv.winRate ?? null, fmt: pct },
    ];
  return (
    <div className="stack">
      <div className="modal-head"><h2>Compare <em style={{ color: 'var(--accent-2)' }}>players</em></h2></div>
      <Tabs tabs={[...L.seasons.map((s) => ({ key: s.id, label: s.name })), { key: 'all', label: 'All-time' }]} active={scope} onChange={setScope} />
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && setIds([...new Set([...ids, e.target.value])].slice(0, 4))}>
          <option value="">+ Add player (max 4)</option>
          {L.playerList.filter((p) => !ids.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th />{ids.map((id) => (
            <th key={id} className="n" style={{ textTransform: 'none' }}>
              <div className="stack" style={{ alignItems: 'center', gap: 4 }}>
                <Avatar src={L.players[id]?.avatarUrl} name={L.players[id]?.name} />
                <span style={{ color: 'var(--text)' }}>{L.players[id]?.name}<Flag country={L.players[id]?.country} /></span>
                <TeamChip team={L.players[id]?.currentTeamId ? L.teams[L.players[id].currentTeamId!] : null} />
                <button className="btn sm ghost" onClick={() => setIds(ids.filter((x) => x !== id))}>remove</button>
              </div>
            </th>))}</tr></thead>
          <tbody>{metrics.map((m) => {
            const vals = ids.map((id) => m.get(id));
            const best = Math.max(...vals.map((v) => v ?? -Infinity));
            return (
              <tr key={m.label}><td className="muted">{m.label}</td>{ids.map((id, i) => (
                <td key={id} className="n" style={{ fontWeight: vals[i] === best && ids.length > 1 && best > 0 ? 800 : 400, color: vals[i] === best && ids.length > 1 && best > 0 ? 'var(--accent-2)' : undefined }}>
                  {m.fmt ? m.fmt(vals[i]) : vals[i] ?? '—'}
                </td>))}</tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}
