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

/** One reference found in a workspace note. */
export interface Citation {
  note: string;
  line: number;
  label: string;
  /** Resolved workspace path of the cited file. */
  path: string;
  dest: string;
  quote?: string;
  /** For live code links: the cited lines mapped to where they are now. */
  lines?: { start: number; end: number };
}

export interface GitHubAccount {
  login: string;
  name: string;
}

export interface SharingInfo {
  /** The online copy's address, if this workspace has one. */
  remote: string | null;
  github: { owner: string; repo: string } | null;
  /** Versions here that the online copy doesn't have yet ("changes to share"). */
  ahead: number;
  /** Versions online that aren't here yet ("updates available"). */
  behind: number;
  conflicts: string[];
  error?: string;
  account: GitHubAccount | null;
  /** False when this build has no GitHub OAuth client ID. */
  canSignIn: boolean;
}

export interface SyncResult {
  conflicts: string[];
  pulled: number;
  pushed: number;
}

export interface Person {
  login: string;
  status: 'owner' | 'member' | 'invited';
}

export interface RepoSummary {
  fullName: string;
  private: boolean;
  updated: string;
  description: string;
}

export interface Invitation {
  id: number;
  fullName: string;
  inviter: string;
}

export type Terminology = 'simple' | 'git';

export interface Settings {
  terminology: Terminology;
  theme: string;
  dark: 'system' | 'light' | 'dark';
  recentWorkspaces: string[];
  splitRatio: number;
  autosave: boolean;
  /** Zoom of the notes editor and of the document viewers (1 = 100%), set separately. */
  noteZoom: number;
  docZoom: number;
  /** Most tabs open at once on each side (0 = no limit). Opening one more closes the least recently viewed. */
  editorTabLimit: number;
  viewerTabLimit: number;
  /** App version the Claude prompt was last shown for (so it asks once, and again after updates). */
  claudeOffered?: string;
}

/** Claude apps on this computer and the Locus tools installed in them. */
export interface ClaudeStatus {
  code: { found: boolean; current: string; installed?: { version: string; source: 'app' | 'marketplace' } };
  desktop: { found: boolean; current: string; installed?: { version: string }; running?: boolean };
}

export interface Api {
  openWorkspace(dir?: string): Promise<WorkspaceInfo | null>;
  createWorkspace(): Promise<WorkspaceInfo | null>;
  listFiles(rev?: string): Promise<string[]>;
  readFile(path: string, rev?: string): Promise<Uint8Array>;
  readText(path: string, rev?: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  exists(path: string, rev?: string): Promise<boolean>;
  /** Whether the file now differs from the file in a version. */
  fileChangedSince(path: string, rev: string): Promise<boolean>;
  claudeStatus(): Promise<ClaudeStatus>;
  connectClaude(target: 'code' | 'desktop'): Promise<{ ok: boolean; message: string }>;
  restartClaudeDesktop(): Promise<{ ok: boolean; message: string }>;
  appVersion(): Promise<string>;
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
  /** Moves a file or folder and rewrites every link to it. Returns the notes that changed. */
  renameFile(from: string, to: string): Promise<{ updatedNotes: string[]; links: number }>;
  /** Where a file that existed at `at` lives now, if it was moved outside the app. */
  findMoved(path: string, at: string): Promise<string | null>;
  /** Every reference in every note of the workspace. */
  citations(): Promise<Citation[]>;
  /** What a version changed compared with the one before it. */
  versionChanges(sha: string): Promise<FileChange[]>;

  /** Saves the workspace with its history as one file. Asks where when `file` is omitted. */
  exportPackage(file?: string): Promise<string | null>;
  /** Unpacks a package into a new folder and opens it. Asks for missing paths. */
  importPackage(file?: string, dest?: string): Promise<WorkspaceInfo | null>;
  sharingStatus(fetch: boolean): Promise<SharingInfo>;
  sync(): Promise<SyncResult>;
  conflictSides(path: string): Promise<{ mine: Uint8Array | null; theirs: Uint8Array | null; theirsAuthor: string }>;
  /** Returns the path of the extra copy when choosing "both". */
  resolveConflict(path: string, choice: 'mine' | 'theirs' | 'both'): Promise<string | null>;
  finishSync(): Promise<SyncResult>;
  abortSync(): Promise<void>;
  githubSignInStart(): Promise<{ userCode: string; verificationUri: string }>;
  githubSignInWait(): Promise<GitHubAccount>;
  githubSignOut(): Promise<void>;
  githubShare(): Promise<{ owner: string; repo: string }>;
  githubInvite(username: string): Promise<'invited' | 'member'>;
  githubPeople(): Promise<Person[]>;
  githubRepos(): Promise<{ repos: RepoSummary[]; invitations: Invitation[] }>;
  githubAcceptInvitation(id: number): Promise<void>;
  /** Downloads a workspace from GitHub into a new folder and opens it. */
  githubClone(fullName: string, dest?: string): Promise<WorkspaceInfo | null>;
  copyText(text: string): Promise<void>;
}

export const API_METHODS: (keyof Api)[] = [
  'openWorkspace', 'createWorkspace', 'listFiles', 'readFile', 'readText', 'writeText', 'exists', 'fileChangedSince', 'claudeStatus', 'connectClaude', 'restartClaudeDesktop', 'appVersion',
  'head', 'versions', 'changesSince', 'uncommitted', 'saveVersion', 'ensureVersion', 'diffHunks',
  'getSettings', 'setSettings', 'pickExternalFiles', 'readExternal', 'openExternally', 'setTitleBarColors',
  'renameFile', 'findMoved', 'citations', 'versionChanges',
  'exportPackage', 'importPackage', 'sharingStatus', 'sync', 'conflictSides', 'resolveConflict', 'finishSync', 'abortSync',
  'githubSignInStart', 'githubSignInWait', 'githubSignOut', 'githubShare', 'githubInvite', 'githubPeople', 'githubRepos',
  'githubAcceptInvitation', 'githubClone', 'copyText',
];
