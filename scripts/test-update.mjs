// Updating from a release, without GitHub: a little server here plays the release, and Locus
// (run from source with LOCUS_UPDATE_TEST) checks it, downloads the installer and offers to
// restart. Restart now is never pressed, because it would install over the Locus on this computer.
//
//   npm run build && node scripts/test-update.mjs [path\to\Locus-Setup-x.y.z.exe]
//
// Without a path it uses the newest installer in release/.
import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-update');
const current = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const CACHE = 'locus-updater-test';

const newest = () => {
  const dir = join(repo, 'release');
  const found = readdirSync(dir)
    .filter((f) => /^Locus-Setup-[\d.]+\.exe$/.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
};
const installer = process.argv[2] ?? newest();
if (!installer || !existsSync(installer)) throw new Error('No installer to serve: build one or pass its path');
const sha512 = createHash('sha512').update(readFileSync(installer)).digest('base64');
const size = statSync(installer).size;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/** What the server says the release is: a version, or nothing (a release without latest.yml). */
let release = null;
const name = 'Locus-Setup-test.exe';
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/latest.yml' && release) {
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end(`version: ${release}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`);
  } else if (path === `/${name}` && release) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
    createReadStream(installer).pipe(res);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const config = join(out, 'app-update.yml');
writeFileSync(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${CACHE}\n`);
const cacheDir = join(process.env.LOCALAPPDATA ?? '', CACHE);
rmSync(cacheDir, { recursive: true, force: true });

console.log(`serving ${basename(installer)} (${(size / 1e6).toFixed(1)} MB) at ${url}; Locus here is ${current}`);

async function run(label, version, expect) {
  release = version;
  const app = await electron.launch({
    args: [repo],
    env: { ...process.env, LOCUS_USER_DATA: join(out, `user-data-${label}`), LOCUS_UPDATE_TEST: config },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  try {
    await expect(win);
  } catch (e) {
    check(false, `${label}: ${String(e).split('\n')[0]}`);
    await win.screenshot({ path: join(out, `${label}.png`) }).catch(() => undefined);
  }
  check(errors.length === 0, `${label}: no page errors${errors.length ? ` (${errors[0]})` : ''}`);
  await app.close();
}

const settingsLine = async (win) => {
  await win.locator('button[title="Settings"]').click();
  const line = win.locator('.settings-updates .update-line');
  await line.waitFor();
  return line;
};

// A newer release: it downloads, the banner offers to restart, and Settings agrees.
await run('newer', '99.0.0', async (win) => {
  const banner = win.locator('.update-notice');
  await banner.waitFor({ timeout: 120000 });
  const text = await banner.innerText();
  check(text.includes('Locus 99.0.0 is ready to install') && text.includes(`you have ${current}`), 'newer: banner names both versions');
  check(text.includes('installs by itself the next time you close Locus'), 'newer: banner says what happens otherwise');
  check(await banner.getByRole('button', { name: 'Restart now' }).isVisible(), 'newer: Restart now is offered');
  const downloaded = existsSync(join(cacheDir, 'pending')) && readdirSync(join(cacheDir, 'pending')).some((f) => f.endsWith('.exe'));
  check(downloaded, 'newer: the installer was downloaded and checked');
  await win.screenshot({ path: join(out, 'banner.png') });
  await banner.getByRole('button', { name: 'Later' }).click();
  check((await banner.count()) === 0, 'newer: Later hides the banner');
  const line = await settingsLine(win);
  check((await line.innerText()).includes('99.0.0 is downloaded'), 'newer: Settings says it is downloaded');
  check(await win.locator('.settings-updates').getByRole('button', { name: 'Restart now' }).isVisible(), 'newer: Settings offers Restart now');
  await win.locator('.settings-updates').scrollIntoViewIfNeeded();
  await win.screenshot({ path: join(out, 'settings.png') });
});

// The same version: up to date, no banner.
await run('same', current, async (win) => {
  const line = await settingsLine(win);
  await win.waitForFunction(() => /Up to date/.test(document.querySelector('.settings-updates .update-line')?.textContent ?? ''), null, { timeout: 30000 });
  check(true, 'same: Settings says up to date');
  check((await win.locator('.update-notice').count()) === 0, 'same: no banner');
  await win.locator('.settings-updates').getByRole('button', { name: 'Check for updates' }).click();
  await win.waitForFunction(() => /Up to date/.test(document.querySelector('.settings-updates .update-line')?.textContent ?? ''), null, { timeout: 30000 });
  check(true, 'same: Check for updates checks again');
  void line;
});

// A release with no update information: said quietly in Settings, never a banner.
await run('missing', null, async (win) => {
  await settingsLine(win);
  await win.waitForFunction(() => /Couldn't check/.test(document.querySelector('.settings-updates .update-line')?.textContent ?? ''), null, { timeout: 30000 });
  const text = await win.locator('.settings-updates .update-line').innerText();
  check(text.includes('no update information'), `missing: Settings explains (${text})`);
  check((await win.locator('.update-notice').count()) === 0, 'missing: no banner');
});

server.close();
rmSync(cacheDir, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
