import { useEffect, useMemo, useState } from 'react';
import { doc, serverTimestamp } from 'firebase/firestore';
import { setDoc } from '../lib/db';
import { marked } from 'marked';
import { call, db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useCol, useDoc } from '../lib/hooks';
import { SectionHeader, useAction, Avatar, TeamChip } from '../components/ui';
import { fmtAgo } from '../lib/format';
import { actor } from './util';

export function AdminRules() {
  const { data: rules } = useDoc<{ markdown: string; updatedAt?: { toMillis(): number }; publishedAt?: { toMillis(): number }; discordMessageIds?: string[] }>('content/rules');
  const [md, setMd] = useState('');
  const { run, busy } = useAction();
  useEffect(() => { if (rules?.markdown !== undefined) setMd(rules.markdown); }, [rules?.markdown]);
  // Escape raw HTML so preview can't inject markup; markdown formatting still renders.
  const html = useMemo(() => marked.parse(md.replace(/</g, '&lt;'), { async: false }) as string, [md]);
  const save = () => setDoc(doc(db, 'content/rules'), { markdown: md, updatedBy: actor(), updatedAt: serverTimestamp() }, { merge: true });
  return (
    <>
      <SectionHeader eyebrow="Content" title="League" accent="rules" />
      <div className="row wrap small muted">
        {rules?.updatedAt && <span>Saved {fmtAgo(rules.updatedAt)}</span>}
        {rules?.publishedAt && <span>· Published to Discord {fmtAgo(rules.publishedAt)} ({rules.discordMessageIds?.length || 0} messages)</span>}
      </div>
      <div className="grid-2">
        <textarea className="textarea" style={{ minHeight: 480 }} value={md} onChange={(e) => setMd(e.target.value)} placeholder="# League rules&#10;&#10;## 1. Format…" />
        <div className="card markdown" style={{ maxHeight: 480, overflowY: 'auto' }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => run(save, 'Rules saved')}>💾 Save</button>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await save(); return call<unknown, { messages: number; lengths: number[] }>('publishRules')({}); }, (r) => `Published ${r.messages} Discord messages (max ${Math.max(0, ...r.lengths)} chars)`)}>📣 Save & publish to Discord</button>
      </div>
      <p className="small muted">Publishing unwraps paragraphs, splits at headings into messages under 2,000 characters, and edits the existing Discord messages in place (extra ones are added or removed).</p>
    </>
  );
}

export function AdminRatings() {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: ratings } = useCol<{ overall: number; attributes?: Record<string, number>; note?: string }>(L.seasonId ? `seasons/${L.seasonId}/ratings` : null);
  const [draft, setDraft] = useState<Record<string, { overall: string; note: string }>>({});
  const [team, setTeam] = useState('');
  const rated = Object.fromEntries(ratings.map((r) => [r.id, r]));
  const list = L.playerList.filter((p) => (team ? (L.rosters[team] || []).includes(p.id) : Object.values(L.rosters).some((ps) => ps.includes(p.id))));
  return (
    <>
      <SectionHeader eyebrow={`Content · ${L.season?.name || ''}`} title="Player" accent="ratings" />
      <select className="select" style={{ width: 'auto' }} value={team} onChange={(e) => setTeam(e.target.value)}>
        <option value="">All rostered players</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Player</th><th>Team</th><th className="n">Overall</th><th>Note</th><th /></tr></thead>
          <tbody>{list.map((p) => {
            const d = draft[p.id] || { overall: String(rated[p.id]?.overall ?? ''), note: rated[p.id]?.note || '' };
            return (
              <tr key={p.id}>
                <td><span className="row"><Avatar src={p.avatarUrl} name={p.name} size="sm" />{p.name}</span></td>
                <td><TeamChip team={p.currentTeamId ? L.teams[p.currentTeamId] : null} /></td>
                <td className="n"><input className="input num-in" type="number" min={0} max={100} value={d.overall} onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, overall: e.target.value } })} /></td>
                <td><input className="input" value={d.note} onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, note: e.target.value } })} /></td>
                <td><button className="btn sm" disabled={busy || !draft[p.id]} onClick={() => run(() => setDoc(doc(db, `seasons/${L.seasonId}/ratings/${p.id}`), {
                  overall: Number(d.overall) || 0, note: d.note, attributes: rated[p.id]?.attributes || {}, updatedBy: actor(),
                }), 'Rating saved')}>Save</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </>
  );
}
