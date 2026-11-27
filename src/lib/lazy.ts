import { lazy, type ComponentType } from 'react';

const FLAG = 'srl_chunk_reload';

/**
 * React.lazy that survives a redeploy. Each deploy renames the code chunks, so a tab opened before the deploy
 * asks for a file that no longer exists the first time it opens a lazily loaded view (a match popup, the
 * admin panel). Instead of failing, reload the page once to pick up the new build. The session flag stops a
 * reload loop when the failure is something else, such as being offline; then the error reaches the
 * nearest error boundary.
 */
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().then(
    (mod) => { try { sessionStorage.removeItem(FLAG); } catch { /* storage blocked */ } return mod; },
    (err) => {
      let reloaded = true;
      try { reloaded = !!sessionStorage.getItem(FLAG); if (!reloaded) sessionStorage.setItem(FLAG, '1'); } catch { /* storage blocked */ }
      if (reloaded) throw err;
      location.reload();
      return new Promise<never>(() => undefined); // keep showing the fallback until the reload happens
    },
  ));
}
