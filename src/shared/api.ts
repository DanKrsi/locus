// The contract between the renderer and the main process. All paths are workspace
// root-relative with a leading "/" unless stated otherwise.

export interface WorkspaceInfo {
  root: string;
  name: string;
  /** True when the app created the history; false for a repo with its own history (developer mode). */
  managed: boolean;
}

export interface Version {
  sha: string;
  date: string;
  message: string;
  auto: boolean;
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** Previous path for renames. */
  from?: string;
}

export type Terminology = 'simple' | 'git';

export interface Settings {
  terminology: Terminology;
  theme: string;
  dark: 'system' | 'light' | 'dark';
  recentWorkspaces: string[];
  splitRatio: number;
  autosave: boolean;
}

export interface Api {
  openWorkspace(dir?: string): Promise<WorkspaceInfo | null>;
  createWorkspace(): Promise<WorkspaceInfo | null>;
  listFiles(rev?: string): Promise<string[]>;
  readFile(path: string, rev?: string): Promise<Uint8Array>;
  readText(path: string, rev?: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  exists(path: string, rev?: string): Promise<boolean>;
  head(): Promise<string | null>;
  versions(path?: string): Promise<Version[]>;
  changesSince(rev: string): Promise<FileChange[]>;
  uncommitted(): Promise<FileChange[]>;
  saveVersion(message: string): Promise<string | null>;
  /** Returns a version that contains the file's current content, saving an automatic one if needed. */
  ensureVersion(path: string): Promise<string | null>;
  /** Lines changed between a version and the working file, as unified-diff hunks. */
  diffHunks(path: string, from: string): Promise<{ oldStart: number; oldLines: number; newStart: number; newLines: number }[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  pickExternalFiles(): Promise<string[]>;
  readExternal(absPath: string): Promise<Uint8Array>;
  openExternally(path: string): Promise<void>;
  setTitleBarColors(bg: string, fg: string): Promise<void>;
}

export const API_METHODS: (keyof Api)[] = [
  'openWorkspace', 'createWorkspace', 'listFiles', 'readFile', 'readText', 'writeText', 'exists',
  'head', 'versions', 'changesSince', 'uncommitted', 'saveVersion', 'ensureVersion', 'diffHunks',
  'getSettings', 'setSettings', 'pickExternalFiles', 'readExternal', 'openExternally', 'setTitleBarColors',
];
