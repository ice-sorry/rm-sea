import { useState } from 'react';
import { useLeague } from '../lib/league';
import { useDoc } from '../lib/hooks';
import { Avatar, TeamChip, Empty, Tabs, Flag } from '../components/ui';
import { useModal } from './ModalContext';
import { LEADER_CATEGORIES } from '../lib/types';
import type { PlayerStatRow, RecordsDoc } from '../lib/types';

const value = (r: PlayerStatRow, k: string) => (k === 'contributions' ? r.goals + r.assists : k === 'rating' ? r.rating ?? 0 : Number((r as unknown as Record<string, number>)[k] || 0));
const CAREER_KEYS: Record<string, 'goals' | 'assists' | 'mvps' | 'saves' | 'gp'> = { goals: 'goals', assists: 'assists', mvps: 'mvps', saves: 'saves' };

export default function LeaderboardModal({ category }: { category: string }) {
  const L = useLeague();
  const { open } = useModal();
  const [scope, setScope] = useState<'season' | 'all'>('season');
  const { data: records } = useDoc<RecordsDoc>('derived/records');
  const cat = LEADER_CATEGORIES.find((c) => c.key === category);
  const careerKey = CAREER_KEYS[category];
  const rows = scope === 'season'
    ? (L.playerStats?.rows || []).map((r) => ({ playerId: r.playerId, teamId: r.teamId, v: value(r, category) }))
    : Object.entries(records?.career || {}).map(([pid, c]) => ({ playerId: pid, teamId: L.players[pid]?.currentTeamId || null, v: careerKey ? c[careerKey] : 0 }));
  const sorted = rows.filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
  return (
    <div>
      <div className="modal-head"><span style={{ fontSize: 36 }}>{cat?.emoji}</span><h2>{cat?.label}</h2></div>
      {careerKey && <Tabs tabs={[{ key: 'season', label: L.season?.name || 'Season' }, { key: 'all', label: 'All-time' }]} active={scope} onChange={setScope} />}
      {!sorted.length ? <Empty>No data yet.</Empty> : sorted.map((r, i) => {
        const p = L.players[r.playerId];
        return (
          <div key={r.playerId} className="leader" onClick={() => open({ kind: 'player', id: r.playerId })}>
            <span className="rank">{i + 1}</span><Avatar src={p?.avatarUrl} name={p?.name} />
            <div className="grow"><div className="name" style={{ fontWeight: 600 }}>{p?.name || 'Unknown'}<Flag country={p?.country} /></div><TeamChip team={r.teamId ? L.teams[r.teamId] : null} /></div>
            <span className="value num">{r.v}</span>
          </div>
        );
      })}
    </div>
  );
}
