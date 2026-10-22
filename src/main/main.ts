import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Api, Settings, WorkspaceInfo } from '../shared/api';
import { API_METHODS } from '../shared/api';
import * as git from './git';
import { parseDestination, resolvePath } from '../core/link';
import { extractLinks } from '../core/mdlinks';
import { movedPath, rewriteLinks } from '../core/rewrite';
import { mapLines } from '../core/remap';
import { fileKind } from '../core/link';
import type { Citation, GitHubAccount } from '../shared/api';
import * as share from './share';
import * as gh from './github';

const RENDERER_DIR = join(__dirname, '..', 'renderer');
const WORKSPACE_DIR = '.locus';

// Lets automated tests run with their own settings, away from the user's.
if (process.env.LOCUS_USER_DATA) app.setPath('userData', process.env.LOCUS_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win: BrowserWindow | null = null;
let workspace: WorkspaceInfo | null = null;

// ---------- Settings ----------

const DEFAULT_SETTINGS: Settings = {
  terminology: 'simple',
  theme: 'forest',
  dark: 'system',
  recentWorkspaces: [],
  splitRatio: 0.5,
  autosave: true,
};

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await fs.mkdir(dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------- Workspace ----------

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/** Finds the workspace root for a folder: nearest .locus, else the git top level, else the folder. */
async function findRoot(dir: string): Promise<string> {
  for (let d = dir; ; ) {
    if (await exists(join(d, WORKSPACE_DIR))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return (await git.topLevel(dir)) ?? dir;
}

async function openWorkspaceAt(dir: string): Promise<WorkspaceInfo> {
  const root = resolve(await findRoot(dir));
  const metaFile = join(root, WORKSPACE_DIR, 'workspace.json');
  let meta: { format: number; name: string; managed: boolean };
  if (await exists(metaFile)) {
    meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    if (!(await git.isRepo(root))) await git.init(root);
  } else {
    const hadHistory = await git.isRepo(root);
    meta = { format: 1, name: basename(root), managed: !hadHistory };
    await fs.mkdir(join(root, WORKSPACE_DIR), { recursive: true });
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n');
    await fs.writeFile(join(root, WORKSPACE_DIR, '.gitignore'), 'cache/\n');
    if (!hadHistory) {
      await git.init(root);
      await git.commitAll(root, 'Workspace created');
    }
  }
  await git.ensureIdentity(root);
  workspace = { root, name: meta.name, managed: meta.managed };
  const settings = await loadSettings();
  await saveSettings({ recentWorkspaces: [root, ...settings.recentWorkspaces.filter((r) => r !== root)].slice(0, 10) });
  return workspace;
}

function ws(): WorkspaceInfo {
  if (!workspace) throw new Error('No workspace is open');
  return workspace;
}

/** Maps a workspace path ("/a/b.txt") to an absolute path, refusing anything outside the workspace. */
function abs(path: string): string {
  const root = ws().root;
  const full = resolve(root, '.' + path.replace(/\\/g, '/'));
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${path}`);
  return full;
}

// ---------- Citation index ----------

const citationCache = new Map<string, { mtime: number; cites: Citation[] }>();

async function citationsIn(note: string): Promise<Citation[]> {
  const full = abs(note);
  const st = await fs.stat(full).catch(() => null);
  if (!st) return [];
  const key = `${ws().root}|${note}`;
  const cached = citationCache.get(key);
  if (cached && cached.mtime === st.mtimeMs) return cached.cites;
  const md = await fs.readFile(full, 'utf8');
  const cites: Citation[] = [];
  for (const link of extractLinks(md)) {
    const ref = parseDestination(link.dest);
    if (!ref || ref.pathKind === 'web' || ref.pathKind === 'external' || !ref.path) continue;
    cites.push({ note, line: link.line, label: link.label, path: resolvePath(ref, note), dest: link.dest, quote: link.title });
  }
  citationCache.set(key, { mtime: st.mtimeMs, cites });
  return cites;
}

async function workspaceNotes(): Promise<string[]> {
  return (await git.listWorking(ws().root)).filter((p) => /.md$/i.test(p) && !p.startsWith('/.locus/'));
}

// ---------- GitHub account ----------

interface StoredAccount extends GitHubAccount {
  email: string;
  token: string;
}

const accountFile = () => join(app.getPath('userData'), 'github.json');
let account: StoredAccount | null | undefined;
let pendingDevice: gh.DeviceCode | null = null;

async function loadAccount(): Promise<StoredAccount | null> {
  if (account !== undefined) return account;
  try {
    const raw = JSON.parse(await fs.readFile(accountFile(), 'utf8'));
    const token = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : raw.token;
    account = { ...raw, token };
  } catch {
    account = null;
  }
  return account ?? null;
}

async function saveAccount(a: StoredAccount | null): Promise<void> {
  account = a;
  if (!a) {
    await fs.rm(accountFile(), { force: true });
    return;
  }
  // The token is encrypted with Windows' per-user protection (DPAPI) before it touches disk.
  const token = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(a.token).toString('base64') : a.token;
  await fs.writeFile(accountFile(), JSON.stringify({ ...a, token }));
}

async function token(): Promise<string | undefined> {
  return (await loadAccount())?.token;
}

function requireAccount(a: StoredAccount | null): StoredAccount {
  if (!a) throw new Error('Sign in with GitHub first');
  return a;
}

/** Commits made after signing in carry the person's GitHub name instead of the placeholder. */
async function useAccountIdentity(root: string): Promise<void> {
  const a = await loadAccount();
  if (!a) return;
  await git.setIdentityIfPlaceholder(root, a.name, a.email);
}

async function githubRepoOf(root: string) {
  return gh.parseGitHubUrl(await share.remoteUrl(root));
}

async function documentsFolder(name: string): Promise<string> {
  let dest = join(app.getPath('documents'), 'Locus', name.replace(/[<>:"/\\|?*]/g, '').trim() || 'Workspace');
  for (let i = 2; await exists(dest); i++) dest = join(app.getPath('documents'), 'Locus', `${name} (${i})`);
  return dest;
}

// ---------- API ----------

const api: Api = {
  async openWorkspace(dir) {
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Open a folder' });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    return openWorkspaceAt(dir);
  },
  async createWorkspace() {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose or create an empty folder for the new workspace',
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return openWorkspaceAt(r.filePaths[0]);
  },
  async listFiles(rev) {
    const root = ws().root;
    const files = rev ? await git.listTree(root, rev) : await git.listWorking(root);
    return files.filter((f) => !f.startsWith('/.locus/')).sort();
  },
  async readFile(path, rev) {
    return rev ? git.readBlob(ws().root, path, rev) : fs.readFile(abs(path));
  },
  async readText(path, rev) {
    const buf = await api.readFile(path, rev);
    return new TextDecoder('utf-8').decode(buf);
  },
  async writeText(path, text) {
    const full = abs(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, text, 'utf8');
  },
  async exists(path, rev) {
    return rev ? git.blobExists(ws().root, path, rev) : exists(abs(path));
  },
  async head() {
    return git.head(ws().root);
  },
  async versions(path) {
    return git.log(ws().root, path);
  },
  async changesSince(rev) {
    return git.changesSince(ws().root, rev);
  },
  async uncommitted() {
    return git.uncommitted(ws().root);
  },
  async saveVersion(message) {
    return git.commitAll(ws().root, message || 'Saved version');
  },
  async ensureVersion(path) {
    const w = ws();
    return git.ensureVersion(w.root, path, w.managed);
  },
  async diffHunks(path, from) {
    return git.diffHunks(ws().root, path, from);
  },
  async getSettings() {
    return loadSettings();
  },
  async setSettings(patch) {
    return saveSettings(patch);
  },
  async pickExternalFiles() {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  async readExternal(absPath) {
    return fs.readFile(absPath);
  },
  async openExternally(path) {
    const full = /^[A-Za-z]:[\\/]/.test(path) ? path : abs(path);
    await shell.openPath(full);
  },
  async renameFile(from, to) {
    const src = abs(from);
    const dst = abs(to);
    if (await exists(dst)) throw new Error(`${to.slice(1)} already exists`);
    const notesBefore = await workspaceNotes();
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    const change = [{ from, to }];
    const updatedNotes: string[] = [];
    let links = 0;
    for (const oldNote of notesBefore) {
      const newNote = movedPath(oldNote, change) ?? oldNote;
      const file = abs(newNote);
      const text = await fs.readFile(file, 'utf8');
      const r = rewriteLinks(text, oldNote, newNote, change);
      if (!r.count) continue;
      await fs.writeFile(file, r.text, 'utf8');
      updatedNotes.push(newNote);
      links += r.count;
    }
    return { updatedNotes, links };
  },
  async findMoved(path, at) {
    const root = ws().root;
    return git.findMoved(root, path, at, await git.listWorking(root));
  },
  async versionChanges(sha) {
    return git.versionChanges(ws().root, sha);
  },
  async citations() {
    const all: Citation[] = [];
    for (const note of await workspaceNotes()) all.push(...(await citationsIn(note)));
    // Live code links follow their lines through later edits, like following the link does.
    const root = ws().root;
    const hunks = new Map<string, Awaited<ReturnType<typeof git.diffHunks>> | null>();
    return Promise.all(
      all.map(async (c) => {
        const ref = parseDestination(c.dest);
        if (!ref?.loc.lines || ref.rev || !ref.at || fileKind(c.path) !== 'code') return c;
        const key = c.path + '@' + ref.at;
        if (!hunks.has(key)) hunks.set(key, await git.diffHunks(root, c.path, ref.at).catch(() => null));
        const h = hunks.get(key);
        if (!h) return c;
        const m = mapLines(h, ref.loc.lines.start, ref.loc.lines.end);
        return { ...c, lines: { start: m.start, end: m.end } };
      }),
    );
  },
  async exportPackage(file) {
    const w = ws();
    if (!file) {
      const r = await dialog.showSaveDialog(win!, {
        title: 'Share as a file',
        defaultPath: join(app.getPath('documents'), `${w.name}.locus`),
        filters: [{ name: 'Locus package', extensions: ['locus'] }],
      });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    await share.exportPackage(w.root, file, w.managed);
    return file;
  },
  async importPackage(file, dest) {
    if (!file) {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Open a shared package',
        filters: [{ name: 'Locus package', extensions: ['locus'] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    dest ??= await documentsFolder(basename(file).replace(/\.locus$/i, ''));
    await share.importPackage(file, dest);
    return openWorkspaceAt(dest);
  },
  async sharingStatus(doFetch) {
    const w = ws();
    const a = await loadAccount();
    const st = await share.status(w.root, a?.token, doFetch);
    return {
      ...st,
      github: gh.parseGitHubUrl(st.remote),
      account: a ? { login: a.login, name: a.name } : null,
      canSignIn: !!gh.GITHUB_CLIENT_ID,
    };
  },
  async sync() {
    const w = ws();
    await useAccountIdentity(w.root);
    return share.sync(w.root, await token(), 'Synced changes', w.managed);
  },
  async conflictSides(path) {
    return share.conflictSides(ws().root, path);
  },
  async resolveConflict(path, choice) {
    return share.resolve(ws().root, path, choice);
  },
  async finishSync() {
    return share.finishSync(ws().root, await token());
  },
  async abortSync() {
    await share.abortSync(ws().root);
  },
  async githubSignInStart() {
    pendingDevice = await gh.startDeviceFlow();
    await shell.openExternal(pendingDevice.verificationUri);
    return { userCode: pendingDevice.userCode, verificationUri: pendingDevice.verificationUri };
  },
  async githubSignInWait() {
    if (!pendingDevice) throw new Error('Start sign-in first');
    const t = await gh.pollDeviceFlow(pendingDevice);
    pendingDevice = null;
    const user = await gh.getUser(t);
    await saveAccount({ ...user, token: t });
    return { login: user.login, name: user.name };
  },
  async githubSignOut() {
    await saveAccount(null);
  },
  async githubShare() {
    const w = ws();
    const a = requireAccount(await loadAccount());
    const existing = await githubRepoOf(w.root);
    if (existing) return existing;
    await useAccountIdentity(w.root);
    const repo = await gh.createRepo(a.token, w.name, `Locus workspace: ${w.name}`);
    await share.setRemote(w.root, repo.cloneUrl);
    await share.sync(w.root, a.token, 'Shared online', w.managed);
    return { owner: repo.owner, repo: repo.repo };
  },
  async githubInvite(username) {
    const a = requireAccount(await loadAccount());
    const r = await githubRepoOf(ws().root);
    if (!r) throw new Error('Share this workspace online first');
    return gh.invite(a.token, r.owner, r.repo, username);
  },
  async githubPeople() {
    const a = requireAccount(await loadAccount());
    const r = await githubRepoOf(ws().root);
    return r ? gh.people(a.token, r.owner, r.repo) : [];
  },
  async githubRepos() {
    const a = requireAccount(await loadAccount());
    const [repos, invitations] = await Promise.all([gh.listRepos(a.token), gh.listInvitations(a.token).catch(() => [])]);
    return { repos, invitations };
  },
  async githubAcceptInvitation(id) {
    await gh.acceptInvitation(requireAccount(await loadAccount()).token, id);
  },
  async githubClone(fullName, dest) {
    const a = requireAccount(await loadAccount());
    dest ??= await documentsFolder(fullName.split('/')[1]);
    await share.cloneRemote(`https://github.com/${fullName}.git`, dest, a.token);
    await git.setIdentityIfPlaceholder(dest, a.name, a.email);
    return openWorkspaceAt(dest);
  },
  async copyText(text) {
    clipboard.writeText(text);
  },
  async setTitleBarColors(bg, fg) {
    win?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 });
  },
};

ipcMain.handle('api', async (_e, method: keyof Api, args: unknown[]) => {
  if (!API_METHODS.includes(method)) throw new Error(`Unknown method ${method}`);
  return (api[method] as (...a: unknown[]) => Promise<unknown>)(...args);
});

// ---------- Window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Locus',
    backgroundColor: '#f5f6f3',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f6f3', symbolColor: '#1f2328', height: 40 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://renderer/index.html');
}

/** A .locus file, a folder, or a locus://open?repo=owner/name link passed on the command line. */
function openRequestFrom(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (/^locus:\/\//i.test(a) || /\.locus$/i.test(a)) return a;
  }
  return null;
}

let pendingOpen = openRequestFrom(process.argv);

function deliverOpen(req: string | null) {
  if (!req) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('open-request', req);
  else pendingOpen = req;
}

if (!process.env.LOCUS_USER_DATA && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
    deliverOpen(openRequestFrom(argv));
  });
}

// Only installed builds register as the handler for locus:// links, never dev or test runs.
if (app.isPackaged) app.setAsDefaultProtocolClient('locus');

ipcMain.handle('pending-open', () => {
  const req = pendingOpen;
  pendingOpen = null;
  return req;
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = join(RENDERER_DIR, decodeURIComponent(pathname));
    if (relative(RENDERER_DIR, file).startsWith('..')) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
