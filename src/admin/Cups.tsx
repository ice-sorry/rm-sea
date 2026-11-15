import { useState } from 'react';
import { collection, doc, serverTimestamp } from 'firebase/firestore';
import { addDoc, updateDoc, writeBatch } from '../lib/db';
import { call, db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useCol } from '../lib/hooks';
import { SectionHeader, Empty, Field, useAction, Confirm, Crest } from '../components/ui';
import { BracketView } from '../components/league';
import { KickoffEditor } from '../components/player';
import { CupTeams } from '../pages/CupsPage';
import { buildKnockout, cupTeamIds, shuffled } from '../lib/types';
import type { Cup, MatchDoc } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { Dices, Pencil, Trophy } from 'lucide-react';

/** Rebuild a cup's bracket from a seeding order: clears its unplayed fixtures, then creates the new first round (byes advance). */
async function redraw(cup: Pick<Cup, 'id' | 'name'>, order: string[], matches: MatchDoc[]) {
  const b = writeBatch(db);
  matches.forEach((m) => b.delete(doc(db, `cups/${cup.id}/matches/${m.id}`)));
  b.update(doc(db, 'cups', cup.id), { teamIds: order, bracket: buildKnockout(cup.name, order), championTeamId: null, status: 'live' });
  await b.commit();
  await call('afterCupMatchWrite')({ cupId: cup.id });
}

function TeamPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const L = useLeague();
  return (
    <div className="row wrap">{L.teamList.filter((t) => t.active !== false || value.includes(t.id)).map((t) => (
      <label key={t.id} className="check small card" style={{ padding: '4px 8px' }}>
        <input type="checkbox" checked={value.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} />
        <Crest team={t} size="sm" />{t.name}
      </label>
    ))}</div>
  );
}

export function AdminCups() {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: cups } = useCol<Cup>('cups');
  const [f, setF] = useState({ name: '', teamIds: [] as string[] });
  const [showArchived, setShowArchived] = useState(false);
  const create = (random: boolean) => run(async () => {
    const name = f.name.trim();
    const order = random ? shuffled(f.teamIds) : f.teamIds;
    const ref = await addDoc(collection(db, 'cups'), {
      name, seasonId: L.general.currentSeasonId || null, status: 'live', teamIds: order, bracket: buildKnockout(name, order),
      championTeamId: null, archived: false, createdAt: serverTimestamp(),
    });
    await call('afterCupMatchWrite')({ cupId: ref.id });
    setF({ name: '', teamIds: [] });
  }, 'Cup created with first-round fixtures');
  const list = cups.filter((c) => showArchived || !c.archived).sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
  return (
    <>
      <SectionHeader eyebrow="Season" title="Cups" accent="& knockouts" />
      <div className="card stack">
        <h3>+ New cup</h3>
        <Field label="Name"><input className="input" style={{ maxWidth: 360 }} value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={`Teams (${f.teamIds.length})`}><TeamPicker value={f.teamIds} onChange={(teamIds) => setF({ ...f, teamIds })} /></Field>
        <p className="small muted" style={{ margin: 0 }}>Single elimination. Seeded in the order you tick teams, or draw at random. Byes go to the top seeds when the count isn't a power of two, and those teams go straight through.</p>
        <div className="row wrap">
          <button className="btn primary" disabled={busy || f.name.trim().length < 2 || f.teamIds.length < 2} onClick={() => create(true)}><Dices size={15} aria-hidden />Create with random draw</button>
          <button className="btn" disabled={busy || f.name.trim().length < 2 || f.teamIds.length < 2} onClick={() => create(false)}>Create in ticked order</button>
        </div>
      </div>
      <label className="check small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived cups</label>
      {list.map((c) => <CupAdminCard key={c.id} cup={c} />)}
      {!list.length && <Empty>No cups yet.</Empty>}
    </>
  );
}

function CupAdminCard({ cup }: { cup: Cup }) {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: matches } = useCol<MatchDoc>(`cups/${cup.id}/matches`);
  const [edit, setEdit] = useState<{ name: string; teamIds: string[] } | null>(null);
  const played = matches.filter((m) => m.status === 'played');
  const upcoming = matches.filter((m) => m.status !== 'played' && m.status !== 'void').sort((a, b) => a.round - b.round);
  const teamIds = cupTeamIds(cup);
  const locked = played.length > 0;

  const randomize = () => run(async () => {
    if (locked) throw new Error('Results are already in — delete them before redrawing.');
    await redraw(cup, shuffled(teamIds), matches);
  }, 'Bracket redrawn at random');
  const save = () => run(async () => {
    const e = edit!;
    const name = e.name.trim();
    const sameTeams = e.teamIds.length === teamIds.length && e.teamIds.every((t) => teamIds.includes(t));
    if (!sameTeams) {
      if (locked) throw new Error('Results are already in — teams can no longer change.');
      if (e.teamIds.length < 2) throw new Error('A cup needs at least two teams.');
      // Keep existing seeds, add new teams at the end.
      const order = [...teamIds.filter((t) => e.teamIds.includes(t)), ...e.teamIds.filter((t) => !teamIds.includes(t))];
      await updateDoc(doc(db, 'cups', cup.id), { name });
      await redraw({ id: cup.id, name }, order, matches);
    } else {
      await updateDoc(doc(db, 'cups', cup.id), { name, ...(cup.bracket ? { bracket: { ...cup.bracket, name } } : {}) });
    }
    setEdit(null);
  }, 'Cup saved');
  const remove = () => run(async () => {
    const b = writeBatch(db);
    matches.forEach((m) => b.delete(doc(db, `cups/${cup.id}/matches/${m.id}`)));
    b.delete(doc(db, 'cups', cup.id));
    await b.commit();
  }, 'Cup deleted');

  return (
    <div className="card stack">
      <div className="row wrap">
        <h3 style={{ margin: 0 }}><Trophy size={18} aria-hidden />{cup.name}</h3>
        {cup.archived && <span className="badge">archived</span>}
        <span className="grow" />
        <button className="btn sm" disabled={busy} onClick={() => setEdit(edit ? null : { name: cup.name, teamIds })}><Pencil size={14} aria-hidden />Edit</button>
        <Confirm className="btn sm" text={`Redraw ${cup.name} at random? Unplayed fixtures are replaced.`} onYes={randomize}><Dices size={14} aria-hidden />Randomize bracket</Confirm>
        <label className="check small"><input type="checkbox" checked={!!cup.archived} disabled={busy} onChange={(e) => run(() => updateDoc(doc(db, 'cups', cup.id), { archived: e.target.checked, status: e.target.checked ? 'archived' : 'live' }))} />Archived</label>
        <Confirm text={`Delete ${cup.name} and all its fixtures and results?`} onYes={remove}>Delete</Confirm>
      </div>
      {locked && <span className="small muted">{played.length} result{played.length === 1 ? '' : 's'} entered — the draw and teams are fixed.</span>}
      {edit ? (
        <div className="stack">
          <Field label="Name"><input className="input" style={{ maxWidth: 360 }} value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          {!locked && <Field label={`Teams (${edit.teamIds.length})`}><TeamPicker value={edit.teamIds} onChange={(ids) => setEdit({ ...edit, teamIds: ids })} /></Field>}
          <div className="row"><button className="btn primary sm" disabled={busy || edit.name.trim().length < 2} onClick={save}>Save</button><button className="btn sm ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      ) : <CupTeams cup={cup} />}
      <BracketView bracket={cup.bracket} />
      {upcoming.length > 0 && (
        <div className="stack">
          <div className="eyebrow" style={{ margin: 0 }}>Upcoming fixtures</div>
          {upcoming.map((m) => (
            <div key={m.id} className="row wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="row small" style={{ minWidth: 220 }}><Crest team={L.teams[m.homeTeamId]} size="sm" />{L.teams[m.homeTeamId]?.shortName} vs {L.teams[m.awayTeamId]?.shortName}<Crest team={L.teams[m.awayTeamId]} size="sm" /></span>
              <span className="small muted" style={{ minWidth: 140 }}>{m.kickoffAt ? fmtDateTime(m.kickoffAt) : 'Kickoff TBC'}</span>
              <KickoffEditor m={m} cupId={cup.id} />
              <a className="btn sm" href={`#admin/result?cup=${cup.id}&match=${m.id}`}>Enter result</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
