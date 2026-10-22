// Sharing a workspace: single-file packages (git bundles) and syncing with an online copy
// (any git remote; GitHub adds sign-in). See UI spec §7.
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { exec } from './gitexec';
import { commitAll, ensureIdentity, SNAPSHOT_REF } from './git';

export class ShareError extends Error {}

/** Per-command auth for GitHub over HTTPS; never written to the repo's config. */
function authArgs(token?: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

async function git(cwd: string, args: string[], token?: string): Promise<string> {
  const r = await exec([...authArgs(token), ...args], cwd, { env: { GIT_TERMINAL_PROMPT: '0' } });
  if (r.exitCode !== 0) throw new ShareError(friendly(r.stderr));
  return r.stdout;
}

async function tryGit(cwd: string, args: string[], token?: string) {
  return exec([...authArgs(token), ...args], cwd, { env: { GIT_TERMINAL_PROMPT: '0' } });
}

function friendly(stderr: string): string {
  const s = stderr.trim();
  if (/could not resolve host|unable to access|Failed to connect/i.test(s)) return "Couldn't reach the online copy. Check your internet connection.";
  if (/Authentication failed|403|could not read Username/i.test(s)) return 'GitHub refused access. Sign in again, or ask the owner to invite you.';
  if (/repository .* not found|not found/i.test(s)) return "The online copy wasn't found, or you don't have access to it.";
  return s.split('\n').filter(Boolean).pop() ?? 'Git failed';
}

// ---------- Packages ----------

/**
 * Writes the whole workspace history into one file. In app-managed workspaces unsaved changes
 * are saved as a version first; repos with their own history share only what is committed.
 */
export async function exportPackage(root: string, file: string, managed: boolean): Promise<void> {
  if (managed) await commitAll(root, 'Shared as a package');
  await fs.mkdir(dirname(file), { recursive: true });
  await git(root, ['bundle', 'create', file, '--all']);
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/** Unpacks a package into a new folder and returns it. */
export async function importPackage(file: string, dest: string): Promise<string> {
  if (!(await isEmptyDir(dest))) throw new ShareError(`${dest} already exists and isn't empty`);
  await fs.mkdir(dirname(dest), { recursive: true });
  await git(dirname(dest), ['clone', file, dest]);
  await tryGit(dest, ['fetch', file, 'refs/locus/*:refs/locus/*']);
  await git(dest, ['remote', 'remove', 'origin']);
  await ensureIdentity(dest);
  return dest;
}

export function defaultImportFolder(documents: string, file: string): string {
  return join(documents, 'Locus', basename(file, extname(file)).replace(/[<>:"/\\|?*]/g, '').trim() || 'Shared workspace');
}

// ---------- Online copy ----------

export async function remoteUrl(root: string): Promise<string | null> {
  const r = await tryGit(root, ['remote', 'get-url', 'origin']);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function setRemote(root: string, url: string): Promise<void> {
  if (await remoteUrl(root)) await git(root, ['remote', 'set-url', 'origin', url]);
  else await git(root, ['remote', 'add', 'origin', url]);
}

async function branch(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

async function hasRef(root: string, ref: string): Promise<boolean> {
  return (await tryGit(root, ['rev-parse', '--verify', '--quiet', ref])).exitCode === 0;
}

export interface SyncStatus {
  remote: string | null;
  ahead: number;
  behind: number;
  conflicts: string[];
  error?: string;
}

export async function conflicts(root: string): Promise<string[]> {
  const out = (await tryGit(root, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U'])).stdout;
  return out.split('\n').filter(Boolean).map((p) => '/' + p);
}

export async function status(root: string, token: string | undefined, doFetch: boolean): Promise<SyncStatus> {
  const remote = await remoteUrl(root);
  const base: SyncStatus = { remote, ahead: 0, behind: 0, conflicts: await conflicts(root) };
  if (!remote) return base;
  try {
    if (doFetch) await git(root, ['fetch', '--quiet', 'origin'], token);
  } catch (e) {
    base.error = (e as Error).message;
  }
  const b = await branch(root);
  if (!(await hasRef(root, `refs/remotes/origin/${b}`))) {
    base.ahead = Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim());
    return base;
  }
  const [ahead, behind] = (await git(root, ['rev-list', '--left-right', '--count', `HEAD...origin/${b}`])).trim().split(/\s+/).map(Number);
  return { ...base, ahead, behind };
}

export interface SyncResult {
  conflicts: string[];
  pulled: number;
  pushed: number;
}

async function push(root: string, token?: string): Promise<void> {
  await git(root, ['push', '--quiet', '-u', 'origin', 'HEAD'], token);
  if (await hasRef(root, SNAPSHOT_REF)) {
    // Automatic versions are shared too, but never block a sync.
    await tryGit(root, ['push', '--quiet', 'origin', `${SNAPSHOT_REF}:${SNAPSHOT_REF}`], token);
  }
}

/** Save local changes as a version, bring in everyone else's, then share ours. */
export async function sync(root: string, token: string | undefined, message: string, managed: boolean): Promise<SyncResult> {
  if ((await conflicts(root)).length) throw new ShareError('Finish resolving the conflicting files first');
  await ensureIdentity(root);
  if (managed) await commitAll(root, message);
  const before = await status(root, token, true);
  if (before.error) throw new ShareError(before.error);
  const b = await branch(root);
  let pulled = 0;
  if (before.behind > 0) {
    const r = await tryGit(root, ['merge', '--no-edit', `origin/${b}`]);
    if (r.exitCode !== 0) {
      const c = await conflicts(root);
      if (c.length) return { conflicts: c, pulled: before.behind, pushed: 0 };
      throw new ShareError(friendly(r.stderr || r.stdout));
    }
    pulled = before.behind;
  }
  const ahead = (await status(root, token, false)).ahead;
  if (ahead > 0 || !(await hasRef(root, `refs/remotes/origin/${b}`))) await push(root, token);
  return { conflicts: [], pulled, pushed: ahead };
}

// ---------- Conflicts ----------

export interface ConflictSides {
  mine: Buffer | null;
  theirs: Buffer | null;
  theirsAuthor: string;
}

const gp = (p: string) => p.replace(/^\/+/, '');

async function stage(root: string, path: string, n: 2 | 3): Promise<Buffer | null> {
  const r = await exec(['show', `:${n}:${gp(path)}`], root, { encoding: 'buffer' });
  return r.exitCode === 0 ? r.stdout : null;
}

export async function conflictSides(root: string, path: string): Promise<ConflictSides> {
  const author = (await tryGit(root, ['log', '-1', '--format=%an', 'MERGE_HEAD'])).stdout.trim() || 'their';
  return { mine: await stage(root, path, 2), theirs: await stage(root, path, 3), theirsAuthor: author };
}

/** Name for the second copy kept by "Keep both": "Loads (Jane's copy).xlsx". */
export function copyName(path: string, author: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const stem = dot > slash ? path.slice(0, dot) : path;
  const ext = dot > slash ? path.slice(dot) : '';
  const who = author.split(/\s+/)[0] || 'their';
  return `${stem} (${who === 'their' ? 'their' : who + "'s"} copy)${ext}`;
}

export async function resolve(root: string, path: string, choice: 'mine' | 'theirs' | 'both'): Promise<string | null> {
  const sides = await conflictSides(root, path);
  const full = join(root, gp(path));
  let extra: string | null = null;
  const keep = async (data: Buffer | null) => {
    if (data) {
      await fs.writeFile(full, data);
      await git(root, ['add', '--', gp(path)]);
    } else {
      await fs.rm(full, { force: true });
      await git(root, ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', gp(path)]);
    }
  };
  if (choice === 'mine') await keep(sides.mine);
  else if (choice === 'theirs') await keep(sides.theirs);
  else {
    await keep(sides.mine ?? sides.theirs);
    if (sides.mine && sides.theirs) {
      extra = copyName(path, sides.theirsAuthor);
      await fs.writeFile(join(root, gp(extra)), sides.theirs);
      await git(root, ['add', '--', gp(extra)]);
    }
  }
  return extra;
}

/** Completes a sync after all conflicts are resolved. */
export async function finishSync(root: string, token?: string): Promise<SyncResult> {
  const left = await conflicts(root);
  if (left.length) return { conflicts: left, pulled: 0, pushed: 0 };
  await git(root, ['commit', '--no-edit', '--quiet']);
  const ahead = (await status(root, token, false)).ahead;
  await push(root, token);
  return { conflicts: [], pulled: 0, pushed: ahead };
}

export async function abortSync(root: string): Promise<void> {
  await tryGit(root, ['merge', '--abort']);
}

// ---------- Cloning ----------

export async function cloneRemote(url: string, dest: string, token?: string): Promise<string> {
  if (!(await isEmptyDir(dest))) throw new ShareError(`${dest} already exists and isn't empty`);
  await fs.mkdir(dirname(dest), { recursive: true });
  await git(dirname(dest), ['clone', '--quiet', url, dest], token);
  await tryGit(dest, ['fetch', '--quiet', 'origin', 'refs/locus/*:refs/locus/*'], token);
  await ensureIdentity(dest);
  return dest;
}
