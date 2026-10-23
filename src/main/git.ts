// Version history through the git bundled with the app (dugite), so users never install git.
import { exec } from './gitexec';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FileChange, Version } from '../shared/api';

export const SNAPSHOT_REF = 'refs/locus/snapshots';
const AUTO_PREFIX = 'Automatic version';
const MAX_BUFFER = 1024 * 1024 * 1024;

export class GitError extends Error {}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await exec(args, cwd, { env, maxBuffer: MAX_BUFFER });
  if (r.exitCode !== 0) throw new GitError(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const r = await exec(args, cwd);
  return r.exitCode === 0;
}

/** Strips the leading "/" of a workspace path for git. */
const gp = (path: string) => path.replace(/^\/+/, '');
const wp = (path: string) => '/' + path;

export async function isRepo(dir: string): Promise<boolean> {
  return gitOk(dir, ['rev-parse', '--is-inside-work-tree']);
}

export async function topLevel(dir: string): Promise<string | null> {
  const r = await exec(['rev-parse', '--show-toplevel'], dir);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function init(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main']);
  await ensureIdentity(dir);
}

/** A fresh machine has no git identity, which makes commits fail; give the repo a local one. */
export async function ensureIdentity(dir: string): Promise<void> {
  const name = await exec(['config', 'user.name'], dir);
  if (name.exitCode !== 0 || !name.stdout.trim()) await git(dir, ['config', 'user.name', 'Locus']);
  const email = await exec(['config', 'user.email'], dir);
  if (email.exitCode !== 0 || !email.stdout.trim()) await git(dir, ['config', 'user.email', 'noreply@locus.local']);
}

/** Replaces the placeholder identity (set by ensureIdentity) with the signed-in person's. */
export async function setIdentityIfPlaceholder(dir: string, name: string, email: string): Promise<void> {
  const current = (await exec(['config', 'user.email'], dir)).stdout.trim();
  if (current && !current.endsWith('@locus.local')) return;
  await git(dir, ['config', 'user.name', name]);
  await git(dir, ['config', 'user.email', email]);
}

export async function head(dir: string): Promise<string | null> {
  const r = await exec(['rev-parse', '--verify', '--quiet', 'HEAD'], dir);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  return gitOk(dir, ['rev-parse', '--verify', '--quiet', ref]);
}

export async function readBlob(dir: string, path: string, rev: string): Promise<Buffer> {
  const r = await exec(['cat-file', 'blob', `${rev}:${gp(path)}`], dir, { encoding: 'buffer', maxBuffer: MAX_BUFFER });
  if (r.exitCode !== 0) throw new GitError(`No such file in that version: ${path}`);
  return r.stdout;
}

export async function blobExists(dir: string, path: string, rev: string): Promise<boolean> {
  return gitOk(dir, ['cat-file', '-e', `${rev}:${gp(path)}`]);
}

/** Whether the working file differs from the file in a version (true if either is missing). */
export async function changedSince(dir: string, path: string, rev: string): Promise<boolean> {
  const [then, now] = await Promise.all([
    exec(['rev-parse', '--verify', '--quiet', `${rev}:${gp(path)}`], dir),
    exec(['hash-object', '--', gp(path)], dir),
  ]);
  if (then.exitCode !== 0 || now.exitCode !== 0) return true;
  return then.stdout.trim() !== now.stdout.trim();
}

export async function listTree(dir: string, rev: string): Promise<string[]> {
  const out = await git(dir, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', rev]);
  return out.split('\n').filter(Boolean).map(wp);
}

export async function listWorking(dir: string): Promise<string[]> {
  const out = await git(dir, ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard']);
  const files = [...new Set(out.split('\n').filter(Boolean))];
  const present = await Promise.all(files.map((f) => fs.access(join(dir, f)).then(() => true, () => false)));
  return files.filter((_, i) => present[i]).map(wp);
}

export async function log(dir: string, path?: string): Promise<Version[]> {
  if (!(await head(dir))) return [];
  const refs = ['HEAD'];
  if (await refExists(dir, SNAPSHOT_REF)) refs.push(SNAPSHOT_REF);
  const args = ['log', '--date-order', '--format=%H%x1f%aI%x1f%s%x1e', ...refs];
  if (path) args.push('--follow', '--', gp(path));
  const out = await git(dir, args);
  return out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, message] = rec.split('\x1f');
      return { sha, date, message, auto: message.startsWith(AUTO_PREFIX) };
    });
}

function parseNameStatus(out: string): FileChange[] {
  const changes: FileChange[] = [];
  const parts = out.split('\0').filter((p) => p !== '');
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = parts[i++];
      const to = parts[i++];
      changes.push({ path: wp(to), from: wp(from), kind: 'renamed' });
    } else {
      const path = parts[i++];
      const kind = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      changes.push({ path: wp(path), kind });
    }
  }
  return changes;
}

async function untracked(dir: string): Promise<FileChange[]> {
  const out = await git(dir, ['-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean).map((p) => ({ path: wp(p), kind: 'untracked' as const }));
}

/** Changes from a version to the working folder, including new untracked files. */
export async function changesSince(dir: string, rev: string): Promise<FileChange[]> {
  const out = await git(dir, ['diff', '--name-status', '-M', '-z', rev, '--']);
  return [...parseNameStatus(out), ...(await untracked(dir))];
}

export async function uncommitted(dir: string): Promise<FileChange[]> {
  if (!(await head(dir))) return untracked(dir);
  return changesSince(dir, 'HEAD');
}

export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ['add', '-A']);
  const staged = await exec(['diff', '--cached', '--quiet'], dir);
  if (staged.exitCode === 0 && (await head(dir))) return null;
  await git(dir, ['commit', '--allow-empty', '-m', message]);
  return head(dir);
}

async function isDirty(dir: string, path: string): Promise<boolean> {
  const out = await git(dir, ['status', '--porcelain', '--', gp(path)]);
  return out.trim() !== '';
}

/**
 * Returns a version containing the file's current content. In app-managed workspaces this
 * is an ordinary commit of just that file; in repos with their own history it's a commit on
 * SNAPSHOT_REF so the developer's branches stay clean (link-format spec §5).
 */
export async function ensureVersion(dir: string, path: string, managed: boolean): Promise<string | null> {
  const current = await head(dir);
  if (current && !(await isDirty(dir, path))) return current;
  const message = `${AUTO_PREFIX} (cited ${gp(path)})`;
  if (managed) {
    await git(dir, ['add', '--', gp(path)]);
    await git(dir, ['commit', '-m', message, '--', gp(path)]);
    return head(dir);
  }
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const env = { GIT_INDEX_FILE: join(gitDir, 'locus-index') };
  await fs.rm(env.GIT_INDEX_FILE, { force: true });
  if (current) await git(dir, ['read-tree', 'HEAD'], env);
  await git(dir, ['add', '--', gp(path)], env);
  const tree = (await git(dir, ['write-tree'], env)).trim();
  await fs.rm(env.GIT_INDEX_FILE, { force: true });
  const parents: string[] = [];
  if (current) parents.push('-p', current);
  if (await refExists(dir, SNAPSHOT_REF)) parents.push('-p', SNAPSHOT_REF);
  const sha = (await git(dir, ['commit-tree', tree, ...parents, '-m', message])).trim();
  await git(dir, ['update-ref', SNAPSHOT_REF, sha]);
  return sha;
}

export async function diffHunks(dir: string, path: string, from: string) {
  const out = await git(dir, ['diff', '-U0', '--no-color', from, '--', gp(path)]);
  const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[] = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: +m[1],
      oldLines: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3],
      newLines: m[4] === undefined ? 1 : +m[4],
    });
  }
  return hunks;
}

export async function resolveRev(dir: string, rev: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--verify', `${rev}^{commit}`])).trim();
}

/** Finds where a file that existed at `at` lives now: git rename detection, then identical content. */
export async function findMoved(dir: string, path: string, at: string, working: string[]): Promise<string | null> {
  const present = new Set(working);
  const renames = parseNameStatus(await git(dir, ['diff', '--name-status', '-M', '-z', at, '--']));
  const hit = renames.find((c) => c.kind === 'renamed' && c.from === path && present.has(c.path));
  if (hit) return hit.path;
  const r = await exec(['rev-parse', `${at}:${gp(path)}`], dir);
  if (r.exitCode !== 0) return null;
  const blob = r.stdout.trim();
  const ext = path.slice(path.lastIndexOf('.'));
  const candidates = working.filter((p) => p !== path && p.endsWith(ext));
  if (candidates.length) {
    const hashes = (await git(dir, ['hash-object', '--', ...candidates.map(gp)])).trim().split(/\r?\n/);
    const i = hashes.indexOf(blob);
    if (i >= 0) return candidates[i];
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  const same = candidates.filter((p) => p.endsWith('/' + name));
  return same.length === 1 ? same[0] : null;
}

/** Files a version added, changed, renamed or deleted compared with the version before it. */
export async function versionChanges(dir: string, sha: string): Promise<FileChange[]> {
  const out = await git(dir, ['-c', 'core.quotepath=off', 'diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '-z', '--root', sha]);
  return parseNameStatus(out);
}
