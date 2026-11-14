// Puts the installer that GitHub built for a release into release/. Tag-triggered builds happen on
// a runner, so no copy of the published installer ever lands on this machine; this fetches the very
// file people download rather than building a different one locally.
// Usage: npm run fetch-release [-- v0.6.1 | latest] [--demo | --all]
//   no tag     the version in package.json
//   --demo     the demo workspace package instead of the installer
//   --all      both
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'release');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const version = createRequire(import.meta.url)(join(repo, 'package.json')).version;
const tag = args.find((a) => !a.startsWith('--')) ?? `v${version}`;

/** owner/name from the checkout itself, so a fork fetches its own releases. */
function slug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/i);
    if (m) return m[1];
  } catch {
    // No git, or no remote: fall back to where Locus is published.
  }
  return 'DanKrsi/locus';
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function get(url, accept = 'application/vnd.github+json') {
  const res = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'locus-fetch-release' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText} for ${url}`);
  return res;
}

const wanted = (name) =>
  flags.has('--all') ? true : flags.has('--demo') ? name.endsWith('.locus') : /^Locus-Setup-.*\.exe$/i.test(name);

const base = `https://api.github.com/repos/${slug()}/releases`;
const release = await (await get(tag === 'latest' ? `${base}/latest` : `${base}/tags/${tag}`)).json();
const assets = release.assets.filter((a) => wanted(a.name));
if (!assets.length) throw new Error(`${release.tag_name} has nothing matching: ${release.assets.map((a) => a.name).join(', ') || 'no files at all'}`);

await mkdir(out, { recursive: true });
for (const asset of assets) {
  const dest = join(out, asset.name);
  const here = await stat(dest).catch(() => null);
  if (here?.size === asset.size) {
    console.log(`already here  ${dest}  ${mb(here.size)}`);
    continue;
  }
  console.log(`downloading   ${asset.name}  ${mb(asset.size)} from ${release.tag_name}`);
  const part = `${dest}.part`;
  // Written beside it first, so an interrupted download never looks like the real installer.
  const res = await get(asset.browser_download_url, 'application/octet-stream');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  const got = await stat(part);
  if (got.size !== asset.size) {
    await rm(part, { force: true });
    throw new Error(`${asset.name} came to ${mb(got.size)}, but the release says ${mb(asset.size)}`);
  }
  await rm(dest, { force: true });
  await rename(part, dest);
  console.log(`saved         ${dest}  ${mb(got.size)}`);
}
