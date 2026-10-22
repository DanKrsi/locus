// Wording for the Simple / Git terminology setting (UI spec §6). Changes words, never behaviour.
import type { Terminology } from '../shared/api';

const TERMS = {
  version: ['Version', 'Commit'],
  versions: ['Versions', 'Commits'],
  saveVersion: ['Save version', 'Commit'],
  saveVersionHint: ['Save a version of everything in this workspace', 'Commit all changes (git add -A && git commit)'],
  versionName: ['Version name', 'Commit message'],
  autoVersion: ['Automatic version', 'Auto-commit'],
  history: ['Version history', 'Log'],
  historyShort: ['History', 'Log'],
  latest: ['Latest', 'Working tree'],
  unsavedChanges: ['Not saved in a version yet', 'Uncommitted changes'],
  workspace: ['Workspace', 'Repository'],
  viewingOld: ['You are viewing an older version', 'Viewing a past commit'],
  changedSince: ['changed since', 'modified since'],
  deletedLater: ['deleted later', 'deleted since'],
  notYet: ["didn't exist yet", 'not in this commit'],
  newSince: ['new', 'untracked'],
  pinnedTo: ['Version from', 'Pinned to'],
  showFolderAs: ['Show the folder as it was', 'Browse tree at'],
  share: ['Share', 'Share'],
  sync: ['Sync', 'Pull + Push'],
  synced: ['Synced', 'Up to date'],
  changesToShare: ['to share', 'ahead'],
  updatesAvailable: ['updates available', 'behind'],
  shareAsFile: ['Send as a file', 'Export git bundle'],
  openPackage: ['Open a shared file', 'Open git bundle'],
  downloadGitHub: ['Download from GitHub', 'Clone from GitHub'],
  nothingToSave: ['Nothing has changed since the last version', 'Nothing to commit, working tree clean'],
} as const;

export type TermKey = keyof typeof TERMS;

export function term(mode: Terminology, key: TermKey): string {
  return TERMS[key][mode === 'git' ? 1 : 0];
}

/** How a version is named in the UI: a friendly date in Simple mode, a short SHA in Git mode. */
export function versionBadge(mode: Terminology, sha: string, date?: string): string {
  if (mode === 'git' || !date) return sha.slice(0, 7);
  return shortDate(date);
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
