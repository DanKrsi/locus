// Placeholder app icon (page + bookmark) until a real logo is chosen. Renders the logo (icons.tsx) in the default Forest colours to build/icon.png for the installer.
import { _electron as electron } from 'playwright';
import { resolve, join } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 32 32">
  <rect x="6" y="2.5" width="20" height="27" rx="3" fill="#1f5c45"/>
  <path d="M10 11h9M10 15h12M10 19h12M10 23h7" stroke="#e4efe8" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M20 2.5h5v10l-2.5-2.2-2.5 2.2z" fill="#c9a227"/>
</svg>`;
const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: join(repo, 'test-output', 'icon-user-data') } });
const win = await app.firstWindow();
await win.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await win.locator('svg').screenshot({ path: join(repo, 'build', 'icon.png'), omitBackground: true });
await app.close();
console.log('build/icon.png written');
