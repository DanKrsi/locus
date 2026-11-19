// Updates from GitHub. An installed Locus looks for a newer release each time it starts, downloads
// it in the background, and installs it when Locus next closes, or straight away when the update
// banner's Restart now is clicked. Development and test runs never update themselves.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/api';

let status: UpdateStatus = { state: 'idle', current: app.getVersion() };
let notify: (s: UpdateStatus) => void = () => undefined;

const set = (s: Partial<UpdateStatus>) => {
  status = { ...status, ...s };
  notify(status);
};

/**
 * Updates only make sense for an installed copy. LOCUS_UPDATE_TEST, the path of an update config
 * (an app-update.yml), lets a test try it unpackaged against a server of its own.
 */
const updatable = () => app.isPackaged || !!process.env.LOCUS_UPDATE_TEST;

export function updateStatus(): UpdateStatus {
  return status;
}

/** Starts listening and checks once; `send` hears about every change. */
export function startUpdates(send: (s: UpdateStatus) => void) {
  notify = send;
  if (!updatable()) {
    set({ state: 'off' });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  if (process.env.LOCUS_UPDATE_TEST) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = process.env.LOCUS_UPDATE_TEST;
  }
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', latest: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', (info) => set({ state: 'current', latest: info.version, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', latest: info.version, percent: 100 }));
  autoUpdater.on('error', (e) => set({ state: 'error', error: friendly(e) }));
  void checkForUpdates();
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!updatable() || status.state === 'downloading' || status.state === 'ready') return status;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ state: 'error', error: friendly(e) });
  }
  return status;
}

/** Closes Locus, installs the downloaded update without asking, and opens Locus again. */
export function installUpdate() {
  if (status.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_/i.test(msg)) return "Couldn't reach GitHub (no internet connection?).";
  if (/latest\.yml|404/i.test(msg)) return 'The newest release on GitHub has no update information yet.';
  return msg.split('\n')[0].slice(0, 200);
}
