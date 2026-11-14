// Exports from the real app and checks what comes out: a web page and a PDF of a note, and the
// folder for someone without Locus.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/test-export.mjs
import { _electron as electron } from 'playwright';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'export');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');

await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${process.env.VERBOSE ? e.message.slice(0, 1200) : e.message.split('\n')[0]}`);
  }
};
const api = (m, ...a) => win.evaluate(([m, a]) => window.api[m](...a), [m, a]);

await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
let html = '';

await step('a note exports as one web page', async () => {
  const md = await api('readText', '/notes/review.md');
  const file = join(out, 'review.html');
  const written = await api('exportNotePage', '/notes/review.md', md, 'html', file);
  if (written !== file) throw new Error(`wrote ${written}`);
  html = await readFile(file, 'utf8');
  // The note's own formatting.
  if (!/<h1 id="retry-handling-review">Retry handling review<\/h1>/.test(html)) throw new Error('no heading');
  if (!/<li class="task"><input type="checkbox" disabled checked>/.test(html)) throw new Error('no ticked task');
  if (!/<table>.*<th>Item<\/th>/s.test(html)) throw new Error('no table');
  // Nothing of the note's machinery leaks in.
  if (/locus-id|&at=|&rev=/.test(html.replace(/href="[^"]*"/g, ''))) throw new Error('link plumbing showed in the text');
});

await step('its links open the cited documents on this computer', async () => {
  const href = (label) => html.match(new RegExp(`<a href="([^"]+)"[^>]*>${label}`))?.[1];
  const pdf = href('BDS-100 p5');
  if (!pdf?.startsWith('file:///') || !pdf.endsWith('#page=5')) throw new Error(`PDF link: ${pdf}`);
  if (!pdf.includes('/docs/BDS-100%20Bracket%20Design%20Standard.pdf')) throw new Error(`PDF path: ${pdf}`);
  const code = href('the backoff loop');
  if (!code?.endsWith('/src/net/client.py')) throw new Error(`code link: ${code}`);
  // A quote becomes the tooltip, and a section link stays inside the page.
  if (!/title="Retries of a failed proof test/.test(html)) throw new Error('no quote tooltip');
  const section = href('factors of safety');
  if (!section?.endsWith('/notes/design-basis.md#factors-of-safety')) throw new Error(`section link: ${section}`);
});

await step('pictures are inside the file', async () => {
  // A small picture of our own, so the test doesn't depend on what the workspace holds.
  const png = await win.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    const g = c.getContext('2d');
    g.fillStyle = '#1f5c45';
    g.fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await api('writeNewFile', '/images/shot/bracket.png', Uint8Array.from(png));
  const md = '# Shot\n\n![a bracket](/images/shot/bracket.png#w=240)\n';
  await api('writeText', '/notes/shot.md', md);
  const file = join(out, 'shot.html');
  await api('exportNotePage', '/notes/shot.md', md, 'html', file);
  const page = await readFile(file, 'utf8');
  if (!/<img src="data:image\/png;base64,[A-Za-z0-9+/=]{40,}" alt="a bracket" width="240">/.test(page)) throw new Error('the picture is not embedded');
});

await step('a note exports as a PDF', async () => {
  const md = await api('readText', '/notes/review.md');
  const file = join(out, 'review.pdf');
  await api('exportNotePage', '/notes/review.md', md, 'pdf', file);
  const bytes = await readFile(file);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  if (bytes.length < 20000) throw new Error(`suspiciously small: ${bytes.length} bytes`);
});

await app.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
