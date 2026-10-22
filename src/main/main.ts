import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Api, Settings, WorkspaceInfo } from '../shared/api';
import { API_METHODS } from '../shared/api';
import * as git from './git';

const RENDERER_DIR = join(__dirname, '..', 'renderer');
const WORKSPACE_DIR = '.smartdoc';

// Lets automated tests run with their own settings, away from the user's.
if (process.env.SDL_USER_DATA) app.setPath('userData', process.env.SDL_USER_DATA);

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

/** Finds the workspace root for a folder: nearest .smartdoc, else the git top level, else the folder. */
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
    return files.filter((f) => !f.startsWith('/.smartdoc/')).sort();
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
    title: 'Smart Doc Link',
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
