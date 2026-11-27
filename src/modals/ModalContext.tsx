import { Component, createContext, ReactNode, useCallback, useContext, useEffect, useState, Suspense } from 'react';
import { Modal } from '../components/ui';
import { lazyWithReload } from '../lib/lazy';

export type ModalSpec =
  | { kind: 'player'; id: string }
  | { kind: 'team'; id: string }
  | { kind: 'match'; id: string; cupId?: string; seasonId?: string }
  | { kind: 'leaderboard'; category: string; allTime?: boolean }
  | { kind: 'compare'; ids: string[] };

const Ctx = createContext<{ open: (m: ModalSpec) => void; close: () => void }>({ open: () => undefined, close: () => undefined });
export const useModal = () => useContext(Ctx);

/** Hash link to a player's or team's own page. */
export const playerHref = (id: string) => `#player/${encodeURIComponent(id)}`;
export const teamHref = (id: string) => `#team/${encodeURIComponent(id)}`;

const MatchModal = lazyWithReload(() => import('./MatchModal'));
const LeaderboardModal = lazyWithReload(() => import('./LeaderboardModal'));
const CompareModal = lazyWithReload(() => import('./CompareModal'));

/** Keeps a popup that fails to load (or crashes) inside the popup, instead of blanking the whole site. */
class PopupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error('Popup failed', e); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty stack" style={{ alignItems: 'center' }}>
        <span>This couldn't load. The site may have just been updated.</span>
        <button className="btn primary" onClick={() => location.reload()}>Reload the page</button>
      </div>
    );
  }
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ModalSpec[]>([]);
  const open = useCallback((m: ModalSpec) => {
    // Players and teams have their own pages: close any popups and navigate.
    if (m.kind === 'player' || m.kind === 'team') {
      setStack([]);
      location.hash = m.kind === 'player' ? playerHref(m.id) : teamHref(m.id);
      return;
    }
    setStack((s) => [...s, m]);
  }, []);
  const close = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  // Any navigation closes open popups.
  useEffect(() => {
    const onHash = () => setStack([]);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const top = stack[stack.length - 1];
  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      {top && (
        <Modal onClose={close} wide={top.kind === 'compare'}>
          {/* Keyed per popup, so a failure in one doesn't stick to the next one opened. */}
          <PopupBoundary key={stack.length + JSON.stringify(top)}>
            <Suspense fallback={<div className="empty">Loading…</div>}>
              {top.kind === 'match' && <MatchModal id={top.id} cupId={top.cupId} seasonId={top.seasonId} />}
              {top.kind === 'leaderboard' && <LeaderboardModal category={top.category} />}
              {top.kind === 'compare' && <CompareModal initial={top.ids} />}
            </Suspense>
          </PopupBoundary>
        </Modal>
      )}
    </Ctx.Provider>
  );
}
