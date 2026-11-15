// Watches a workspace so the app shows a file the moment another program saves it, instead of
// waiting for the window to be clicked back into. Windows gives us one recursive watch per
// folder, and a burst of events per save, so the paths are gathered and reported together.
import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';

/** Noise no reader cares about: git's own bookkeeping, our cache, and half-written files. */
function ignored(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.includes('.git') || parts.includes('node_modules')) return true;
  if (parts[0] === '.locus' && parts[1] === 'cache') return true;
  const name = parts[parts.length - 1] ?? '';
  return name.startsWith('~$') || name.endsWith('.tmp') || name.endsWith('.part') || name.endsWith('.crdownload');
}

export interface Watcher {
  close(): void;
}

/**
 * Calls `onChange` with the workspace paths (leading slash, forward slashes) that changed, a
 * moment after the changes stop. A save by another program arrives as several events; waiting
 * briefly turns them into one refresh.
 */
export function watchWorkspace(root: string, onChange: (paths: string[]) => void, settle = 250): Watcher {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  const flush = () => {
    timer = undefined;
    if (!pending.size) return;
    const paths = [...pending];
    pending.clear();
    onChange(paths);
  };
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (ignored(rel)) return;
      pending.add('/' + rel.split(sep).join('/'));
      clearTimeout(timer);
      timer = setTimeout(flush, settle);
    });
  } catch {
    // A folder that cannot be watched (a network share, say) simply goes back to refreshing on
    // focus; nothing else about the workspace depends on this.
  }
  return {
    close() {
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
