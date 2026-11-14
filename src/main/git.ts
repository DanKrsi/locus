// Version history through the git bundled with the app (dugite), so users never install git.
import { exec } from './gitexec';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileChange, Version } from '../shared/api';

export const SNAPSHOT_REF = 'refs/locus/snapshots';
export const AUTO_PREFIX = 'Automatic version';
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

/**
 * Every rename between a version and the files as they are now, newest name to the name then.
 * Rename detection needs the whole tree, so this is asked for once per version and held for a
 * moment: a run of links being checked all want the same answer.
 */
const renameCache = new Map<string, { at: number; renames: Promise<Map<string, string>> }>();

function renamesSince(dir: string, rev: string): Promise<Map<string, string>> {
  const key = `${dir}\u0000${rev}`;
  const hit = renameCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.renames;
  const renames = git(dir, ['-c', 'core.quotepath=off', 'diff', '--name-status', '-M', '-z', rev, '--'])
    .then((out) => new Map(parseNameStatus(out).filter((c) => c.kind === 'renamed').map((c) => [c.path, c.from!])))
    .catch(() => new Map<string, string>());
  if (renameCache.size > 8) renameCache.clear();
  renameCache.set(key, { at: Date.now(), renames });
  return renames;
}

/** Every file in a version by content, so a file moved but not yet saved can be found by its bytes. */
const treeCache = new Map<string, Promise<Map<string, string[]>>>();

function blobsIn(dir: string, rev: string): Promise<Map<string, string[]>> {
  const key = `${dir}\u0000${rev}`;
  const hit = treeCache.get(key);
  if (hit) return hit;
  const blobs = git(dir, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '-z', rev])
    .then((out) => {
      const byBlob = new Map<string, string[]>();
      for (const line of out.split('\0').filter(Boolean)) {
        const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.*)$/s);
        if (m) byBlob.set(m[1], [...(byBlob.get(m[1]) ?? []), wp(m[2])]);
      }
      return byBlob;
    })
    .catch(() => new Map<string, string[]>());
  if (treeCache.size > 8) treeCache.clear();
  treeCache.set(key, blobs);
  return blobs;
}

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** The name a file now at `path` went by in `rev`, when it has been renamed or moved since. */
async function renamedFrom(dir: string, path: string, rev: string): Promise<string | null> {
  const renamed = (await renamesSince(dir, rev)).get(path);
  if (renamed) return renamed;
  // Moved but not saved as a version yet: a rename git cannot see, so go by the content itself.
  const hash = await exec(['hash-object', '--', gp(path)], dir);
  if (hash.exitCode !== 0) return null;
  const blob = hash.stdout.trim();
  if (blob === EMPTY_BLOB) return null; // every empty file has these bytes: no evidence of anything
  const same = (await blobsIn(dir, rev)).get(blob);
  if (!same?.length) return null;
  const name = path.slice(path.lastIndexOf('/'));
  return same.find((p) => p.endsWith(name)) ?? same[0];
}

/**
 * What `path` was called in `rev`: itself when it was already there under that name, the name it
 * has since been renamed from, or null when the file was not in that version at all. A link keeps
 * up with a file that moves, so the path it carries is the name now, not the name back then.
 */
export async function pathAt(dir: string, path: string, rev: string): Promise<string | null> {
  if (await gitOk(dir, ['cat-file', '-e', `${rev}:${gp(path)}`])) return path;
  return renamedFrom(dir, path, rev);
}

export async function readBlob(dir: string, path: string, rev: string): Promise<Buffer> {
  const read = (p: string) => exec(['cat-file', 'blob', `${rev}:${gp(p)}`], dir, { encoding: 'buffer', maxBuffer: MAX_BUFFER });
  let r = await read(path);
  if (r.exitCode !== 0) {
    const was = await renamedFrom(dir, path, rev);
    if (was) r = await read(was);
  }
  if (r.exitCode !== 0) throw new GitError(`No such file in that version: ${path}`);
  return r.stdout;
}

export async function blobExists(dir: string, path: string, rev: string): Promise<boolean> {
  return (await pathAt(dir, path, rev)) !== null;
}

/** Whether the working file differs from the file in a version (true if either is missing). */
export async function changedSince(dir: string, path: string, rev: string): Promise<boolean> {
  const was = (await pathAt(dir, path, rev)) ?? path;
  const [then, now] = await Promise.all([
    exec(['rev-parse', '--verify', '--quiet', `${rev}:${gp(was)}`], dir),
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
  return autoVersion(dir, [path], managed, `${AUTO_PREFIX} (cited ${gp(path)})`);
}

/** Saves an automatic version of just these files (see ensureVersion for where it goes). */
export async function autoVersion(dir: string, paths: string[], managed: boolean, message: string): Promise<string | null> {
  const current = await head(dir);
  const files = paths.map(gp);
  if (managed) {
    await git(dir, ['add', '--', ...files]);
    const staged = await exec(['diff', '--cached', '--quiet', '--', ...files], dir);
    if (staged.exitCode === 0 && current) return current;
    await git(dir, ['commit', '-m', message, '--', ...files]);
    return head(dir);
  }
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const env = { GIT_INDEX_FILE: join(gitDir, 'locus-index') };
  await fs.rm(env.GIT_INDEX_FILE, { force: true });
  if (current) await git(dir, ['read-tree', 'HEAD'], env);
  await git(dir, ['add', '--', ...files], env);
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
  // A file that moved is diffed against the name it had in that version, or every line reads as new.
  const was = await renamedFrom(dir, path, from);
  const out = was ? await diffMoved(dir, path, was, from) : await git(dir, ['diff', '-U0', '--no-color', from, '--', gp(path)]);
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

/** The diff of a file against the version it was cited from, under the name it had back then. */
async function diffMoved(dir: string, path: string, was: string, from: string): Promise<string> {
  if (!(await changedSince(dir, path, from))) return ''; // moved, not edited: nothing to map
  if (await gitOk(dir, ['ls-files', '--error-unmatch', '--', gp(path)]))
    return git(dir, ['diff', '-U0', '--no-color', '-M', from, '--', gp(was), gp(path)]);
  // Moved but not saved as a version yet: git cannot pair the old name with a file it does not
  // track, so the old version goes in a file of its own and the two files are compared.
  const temp = join(await fs.mkdtemp(join(tmpdir(), 'locus-diff-')), path.slice(path.lastIndexOf('/') + 1));
  try {
    await fs.writeFile(temp, await readBlob(dir, was, from));
    const r = await exec(['diff', '-U0', '--no-color', '--no-index', '--', temp, join(dir, path.slice(1))], dir, { maxBuffer: MAX_BUFFER });
    return r.stdout;
  } finally {
    await fs.rm(join(temp, '..'), { recursive: true, force: true });
  }
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
