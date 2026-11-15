import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { initials } from '../lib/format';
import { copyPng, downloadPng } from '../lib/exportImage';
import { BRAND } from '../lib/config';
import { errMsg } from '../lib/format';
import type { Team } from '../lib/types';
import { ASIA, OCEANIA, findCountry } from '../lib/countries';

// ---------- Section header: eyebrow + two-tone title with italic accent word ----------
export function SectionHeader({ eyebrow, title, accent, link, linkLabel = 'View all →', right }: {
  eyebrow: string; title: string; accent?: string; link?: string; linkLabel?: string; right?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="title">{title}{accent && <> <em>{accent}</em></>}</h2>
      </div>
      {right}
      {link && <a className="view-all" href={link}>{linkLabel}</a>}
    </div>
  );
}

/** Full-width band in the brand colour at the top of every main page. Render it before <main className="page">. */
export function PageHeader({ eyebrow, title, accent, titleAfter, subtitle, right, children }: {
  eyebrow?: ReactNode; title: string; accent?: string; titleAfter?: ReactNode; subtitle?: ReactNode; right?: ReactNode; children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-inner">
        {children}
        <div className="grow" style={{ minWidth: 0 }}>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h1 className="title">{title}{accent && <> <em>{accent}</em></>}{titleAfter}</h1>
          {subtitle && <div className="page-header-sub">{subtitle}</div>}
        </div>
        {right}
      </div>
    </header>
  );
}

export function StatCard({ value, label }: { value: ReactNode; label: string }) {
  return <div className="stat-card"><div className="big num">{value}</div><div className="label">{label}</div></div>;
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { key: T; label: string; emoji?: string }[]; active: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={`tab ${active === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.emoji && <span aria-hidden>{t.emoji} </span>}{t.label}
        </button>
      ))}
    </div>
  );
}

export function Crest({ team, size = '' }: { team?: Team | null; size?: '' | 'sm' | 'lg' }) {
  if (!team) return <span className={`crest ${size}`} style={{ background: 'var(--surface-2)' }}>?</span>;
  if (team.crestUrl) return <img className={`crest ${size}`} src={team.crestUrl} alt="" style={{ background: team.color }} loading="lazy" />;
  return <span className={`crest ${size}`} style={{ background: team.color || 'var(--accent)' }}>{(team.shortName || initials(team.name)).slice(0, 3)}</span>;
}

export function TeamChip({ team }: { team?: Team | null }) {
  if (!team) return <span className="team-chip muted">Free agent</span>;
  return <span className="team-chip" style={{ boxShadow: `inset 3px 0 0 ${team.color}` }}><Crest team={team} size="sm" />{team.shortName || team.name}</span>;
}

export function FormPills({ form }: { form: string[] }) {
  return <span className="form">{form.map((f, i) => <span key={i} className={`pill ${f}`}>{f}</span>)}</span>;
}

export function Avatar({ src, name, size = '' }: { src?: string | null; name?: string; size?: '' | 'sm' | 'lg' }) {
  if (src) return <img className={`avatar ${size}`} src={src} alt="" loading="lazy" />;
  return <span className={`avatar ${size}`} style={{ display: 'inline-grid', placeItems: 'center', fontSize: 11, fontWeight: 700 }}>{initials(name)}</span>;
}

/** Country flag shown next to a player's name. Renders nothing when the country is unset or unknown. */
export function Flag({ country, size = 'sm' }: { country?: string | null; size?: 'sm' | 'lg' }) {
  const c = findCountry(country);
  if (!c) return null;
  return <img className={`flag ${size}`} src={`https://flagcdn.com/${c.code.toLowerCase()}.svg`} alt={c.name} title={c.name} loading="lazy" />;
}

/** Country dropdown: every Asian and Oceanian country, stored as its ISO code. */
export function CountrySelect({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const cur = findCountry(value);
  const sorted = (list: typeof ASIA) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <select className="select" value={cur?.code || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Not set —</option>
      <optgroup label="Asia">{sorted(ASIA).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</optgroup>
      <optgroup label="Oceania">{sorted(OCEANIA).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</optgroup>
    </select>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Skeleton = ({ rows = 4 }: { rows?: number }) => <div>{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>;

// ---------- Modal sheet ----------
export function Modal({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">✕</button>
        {children}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
interface Toast { id: number; text: string; kind: 'ok' | 'error' }
const ToastCtx = createContext<{ ok: (t: string) => void; error: (e: unknown) => void }>({ ok: () => undefined, error: () => undefined });
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind']) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  const api = useRef({ ok: (t: string) => push(t, 'ok'), error: (e: unknown) => push(errMsg(e), 'error') });
  return (
    <ToastCtx.Provider value={api.current}>
      {children}
      <div className="toasts" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/** Wraps a run-once async action with busy state + toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okText?: string | ((r: T) => string)) => {
    setBusy(true);
    try {
      const r = await fn();
      if (okText) toast.ok(typeof okText === 'function' ? okText(r) : okText);
      return r;
    } catch (e) { toast.error(e); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

// ---------- Image export: branded card ----------
export function ExportCard({ title, filename, children }: { title: string; filename: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { run, busy } = useAction();
  return (
    <div>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        <button className="btn sm" disabled={busy} onClick={() => run(() => copyPng(ref.current!), 'Copied image to clipboard')}>📋 Copy as PNG</button>
        <button className="btn sm" disabled={busy} onClick={() => run(() => downloadPng(ref.current!, filename))}>⬇️ Download PNG</button>
      </div>
      <div ref={ref} className="export-card">
        <div className="export-head">
          <img src={BRAND.logo} alt="" />
          <div>
            <div className="eyebrow" style={{ margin: 0 }}>{BRAND.appName}</div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, textTransform: 'uppercase' }}>{title}</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function Confirm({ text, onYes, children, className = 'btn sm danger' }: { text: string; onYes: () => void; children: ReactNode; className?: string }) {
  return <button className={className} onClick={() => { if (window.confirm(text)) onYes(); }}>{children}</button>;
}
