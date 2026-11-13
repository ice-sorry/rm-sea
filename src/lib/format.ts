import type { Timestamp } from 'firebase/firestore';

type TSLike = Timestamp | { toMillis(): number } | null | undefined;
export const ms = (t: TSLike) => (t && typeof (t as { toMillis?: () => number }).toMillis === 'function' ? t.toMillis() : 0);

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const fmtDate = (t: TSLike) => (ms(t) ? new Date(ms(t)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: tz }) : '');
export const fmtDateTime = (t: TSLike) => (ms(t) ? new Date(ms(t)).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }) : 'TBC');
export const fmtAgo = (t: TSLike) => {
  const d = Date.now() - ms(t);
  if (!ms(t)) return '';
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86400_000)}d ago`;
};
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);
export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
export const initials = (name = '') => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
export const toLocalInput = (t: TSLike) => {
  if (!ms(t)) return '';
  const d = new Date(ms(t));
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};
export const errMsg = (e: unknown) => (e as { message?: string })?.message?.replace(/^Firebase: /, '') || String(e);
