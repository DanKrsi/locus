// The Claude panel with a stand-in for Claude Code (scripts/claude-panel-stub.mjs, started through a
// .cmd in a folder with a space in its name, as an npm install of Claude Code is): the session runs in
// the workspace with the live tools, a selection becomes a chip that Add puts into the prompt,
// current_view sees what is open and selected, show opens places, edits written to a note show in it,
// keys typed in the terminal stay in it, Ctrl+C copies and Ctrl+V pastes, hiding keeps the session,
// the live server turns away requests that aren't the panel's, and the panel's width and being open
// survive a restart.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-claude-panel.mjs
//   (LOCUS_EXE=<path to a packaged Locus.exe> checks an installed build; LOCUS_STUB_DIRECT=1 starts
//   the stand-in without the .cmd)
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-claude-panel');
const userData = join(out, 'user-data');
const stubOut = join(out, 'stub.jsonl');
const workspace = resolve(repo, '..', 'locus-test-workspace');
const stubScript = join(repo, 'scripts', 'claude-panel-stub.mjs');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));
const shimDir = join(out, 'Program Files (x86)', 'claude shim');
const shim = join(shimDir, 'claude.cmd');
await mkdir(shimDir, { recursive: true });
await writeFile(shim, `@node "${stubScript}" %*\r\n`);
const command = process.env.LOCUS_STUB_DIRECT ? ['node', stubScript] : [shim];

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const records = async () =>
  (await readFile(stubOut, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const starts = async () => (await records()).filter((r) => r.event === 'start').length;

// LOCUS_EXE runs a packaged Locus.exe instead of this checkout.
const exe = process.env.LOCUS_EXE;
const errors = [];
const launch = async () => {
  const app = await electron.launch({
    ...(exe ? { executablePath: exe, args: [] } : { args: [repo] }),
    env: { ...process.env, LOCUS_USER_DATA: userData, LOCUS_TERMINAL_CMD: JSON.stringify(command), LOCUS_STUB_OUT: stubOut },
  });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1600, height: 900 });
  win.on('pageerror', (e) => errors.push(String(e)));
  return { app, win };
};
let { app, win } = await launch();

const screen = () => win.evaluate(() => document.querySelector('.claude-panel .xterm-rows')?.textContent ?? '');
const waitScreen = async (pattern, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await screen();
    if (pattern.test(s)) return s;
    await win.waitForTimeout(150);
  }
  return null;
};
const terminal = () => win.locator('.claude-panel .xterm-helper-textarea');
const typeInTerminal = async (text) => {
  await terminal().focus();
  await win.keyboard.type(text);
  await win.keyboard.press('Enter');
};
const notePath = join(workspace, 'notes', 'design-basis.md');
const original = await readFile(notePath, 'utf8');
const panelWidth = () => win.evaluate(() => Math.round(document.querySelector('.claude-panel').getBoundingClientRect().width));

try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });

  // A selection in a note.
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('design-basis');
  await win.locator('.tree-row', { hasText: 'design-basis.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  const line = win.locator('[data-pane="notes"] .cm-line').nth(2);
  await line.waitFor({ timeout: 10000 });
  await line.click();
  await win.keyboard.press('Home');
  await win.keyboard.press('Shift+End');
  const selected = await win.evaluate(() => getSelection()?.toString() ?? '');

  // Open the panel.
  await win.locator('.claude-toggle').click();
  await win.locator('.claude-panel').waitFor({ state: 'visible', timeout: 5000 });
  const ready = await waitScreen(/STUB READY/);
  check(!!ready, `the panel starts the session (Claude stand-in${process.env.LOCUS_STUB_DIRECT ? '' : ', through a .cmd in a folder with spaces'}) in a terminal`);
  check(!!ready && /current_view/.test(ready) && /show/.test(ready), `it gets the live tools current_view and show (${ready?.match(/tools=\S+/)?.[0]})`);
  const start = (await records()).find((r) => r.event === 'start');
  check(start && resolve(start.cwd) === resolve(workspace), 'it runs in the workspace folder');
  check(start?.hasPrompt && start.server.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(start.server.url), 'it is given the Locus prompt and a 127.0.0.1 live server');
  const prompt = start?.args[start.args.indexOf('--append-system-prompt') + 1] ?? '';
  check(/^You are running in the Claude panel inside Locus/.test(prompt) && /keep edits focused\.$/.test(prompt), 'the prompt arrives whole, as one argument');

  // The chip and Add.
  const chip = win.locator('.claude-chip');
  await chip.waitFor({ timeout: 3000 });
  const chipText = await win.locator('.claude-chip-row').textContent();
  check(/Selected in the note/.test(chipText) && /design-basis/.test(chipText), `the note selection shows as a chip ("${chipText.trim()}")`);
  await win.getByRole('button', { name: 'Add to prompt' }).click();
  await win.keyboard.press('Enter');
  await waitScreen(/GOT:/);
  const got = (await records()).find((r) => r.event === 'got');
  check(got && /^\[design-basis\.md\]\(<?\/notes\/design-basis\.md#L3[> ]/.test(got.line), `Add puts a reference link into the prompt (${got?.line.slice(0, 80)})`);
  check(got && selected.trim().length > 0 && got.line.includes(selected.trim().slice(0, 30).replace(/\s+/g, ' ')), 'the link quotes the selected text');

  // current_view
  await typeInTerminal('view');
  await waitScreen(/VIEW /);
  let view = JSON.parse((await records()).filter((r) => r.event === 'view').pop().text);
  check(view.workspace?.folder && view.note?.path === '/notes/design-basis.md', `current_view names the note being edited (${view.note?.path})`);
  check(view.note?.selection?.lines?.start === 3 && view.note.selection.text.trim() === selected.trim(), 'current_view has the selection, its lines and its text');
  check(Array.isArray(view.openNotes) && view.openNotes.includes('/notes/design-basis.md'), 'current_view lists the open notes');

  // show: a PDF page opens on the right, and then current_view sees it.
  await typeInTerminal('show [BDS-100 p5](</docs/BDS-100 Bracket Design Standard.pdf#page=5>)');
  await waitScreen(/SHOWN /);
  const shown = (await records()).filter((r) => r.event === 'show').pop();
  check(/Showing/.test(shown?.text ?? ''), `show answers what it opened (${shown?.text})`);
  await win.waitForTimeout(1500);
  const docTab = await win.evaluate(() => document.querySelector('[data-pane="docs"] .tab.active')?.textContent ?? '');
  check(/BDS-100/.test(docTab), `show opens the document on the right (${docTab.trim()})`);
  await typeInTerminal('view');
  await win.waitForTimeout(800);
  view = JSON.parse((await records()).filter((r) => r.event === 'view').pop().text);
  check(view.document?.path === '/docs/BDS-100 Bracket Design Standard.pdf' && view.document.kind === 'pdf', `current_view then has the document (${view.document?.path})`);
  const place = view.document?.inView ?? view.document?.selected;
  check(place && /#page=5/.test(place.link), `and the page in view (${place?.link})`);
  await typeInTerminal('show </notes/nope.md>');
  await win.waitForTimeout(800);
  check(/Nothing is at/.test((await records()).filter((r) => r.event === 'show').pop()?.text ?? ''), 'show says so when nothing is at the place');

  // Claude's edits. A note without unsaved changes shows an edit as soon as it is written.
  const editorText = () => win.evaluate(() => document.querySelector('[data-pane="notes"] .cm-content')?.textContent ?? '');
  await writeFile(notePath, original.trimEnd() + '\n\nClaude added this line.\n');
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await win.waitForTimeout(150);
    seen = (await editorText()).includes('Claude added this line.');
  }
  check(seen, 'an edit written to the open note (as Claude would) shows in it straight away');
  // A note with unsaved changes: what becomes of each side.
  await win.locator('[data-pane="notes"] .cm-line').last().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type(' Typed by the user.');
  await writeFile(notePath, original.trimEnd() + '\n\nClaude wrote this while you typed.\n');
  await win.waitForTimeout(4000);
  const onDisk = await readFile(notePath, 'utf8');
  const onScreen = await editorText();
  const sides = (t) => [t.includes('while you typed') && "Claude's", t.includes('Typed by the user') && "the user's"].filter(Boolean).join(' and ') || 'neither';
  console.log(`info a note with unsaved changes, written meanwhile: the file has ${sides(onDisk)} text; the screen has ${sides(onScreen)}`);
  await win.keyboard.press('Control+S');
  await win.waitForTimeout(500);

  // Keys typed in the terminal are the terminal's: Ctrl+O doesn't open the file browser.
  await terminal().focus();
  await win.keyboard.press('Control+O');
  await win.waitForTimeout(400);
  check((await win.getByPlaceholder('Find a file by name').count()) === 0, 'Ctrl+O typed in the terminal stays in the terminal');

  // Ctrl+V pastes; Ctrl+C copies selected terminal text (and doesn't interrupt). The clipboard is put back.
  const clipBefore = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('pasted into the panel'));
    await terminal().focus();
    await win.keyboard.press('Control+V');
    await win.keyboard.press('Enter');
    check(!!(await waitScreen(/GOT: pasted into the panel/)), 'Ctrl+V pastes into the terminal');
    const row = await win.locator('.claude-panel .xterm-rows > div').first().boundingBox();
    await win.mouse.click(row.x + 30, row.y + row.height / 2, { clickCount: 3 });
    await win.keyboard.press('Control+C');
    await win.waitForTimeout(300);
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    check(/STUB READY/.test(copied), `Ctrl+C copies the selected terminal text ("${copied.trim().slice(0, 40)}")`);
    await typeInTerminal('after copy');
    check(!!(await waitScreen(/GOT: after copy/)) && (await starts()) === 1, 'and leaves the session running');
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipBefore);
  }

  // Hiding keeps the session; showing it again finds it as it was.
  await win.locator('.claude-toggle').click();
  await win.waitForTimeout(300);
  check(!(await win.locator('.claude-panel').isVisible()), 'the Claude button hides the panel');
  const notesWide = await win.evaluate(() => document.querySelector('[data-pane="docs"]').getBoundingClientRect().right);
  check(notesWide > 1500, 'the notes and documents take the room back');
  await win.locator('.claude-toggle').click();
  await typeInTerminal('still here');
  check(!!(await waitScreen(/GOT: still here/)), 'showing it again finds the same session');
  check((await starts()) === 1, 'the session was not restarted');

  // The live server only answers the panel's session.
  const cfg = JSON.parse(await readFile(join(userData, 'claude-panel-mcp.json'), 'utf8'));
  const { url, headers } = cfg.mcpServers['locus-live'];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (h, u = url) => fetch(u, { method: 'POST', headers: { ...base, ...h }, body }).then((r) => r.status);
  check((await post(headers)) === 200, 'the live server answers with the token');
  check((await post({})) === 401, 'without the token it refuses (401)');
  check((await post({ ...headers, authorization: 'Bearer ' + '0'.repeat(64) })) === 401, 'with a wrong token it refuses (401)');
  check((await post({ ...headers, origin: 'https://example.com' })) === 403, 'a web page (Origin header) is refused (403)');
  check((await post(headers, url.replace('127.0.0.1', 'localhost'))) === 403, 'another host name (DNS rebinding) is refused (403)');

  // Start again restarts the session.
  await win.locator('.claude-panel').getByTitle('Start again (ends what is running)').click();
  await waitScreen(/STUB READY/);
  await win.waitForTimeout(500);
  check((await starts()) === 2, 'Start again starts a new session');

  // Dragging the panel's edge resizes it; the width and the panel being open survive a restart.
  const before = await panelWidth();
  const edge = await win.locator('.panes > .divider').nth(1).boundingBox();
  await win.mouse.move(edge.x + 2, edge.y + 300);
  await win.mouse.down();
  await win.mouse.move(edge.x - 100, edge.y + 300, { steps: 6 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  const after = await panelWidth();
  check(after - before >= 90 && after - before <= 110, `dragging its edge widens the panel (${before} → ${after})`);
  await win.screenshot({ path: join(out, 'panel.png') });
  await app.close();
  ({ app, win } = await launch());
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await win.locator('.claude-panel').waitFor({ state: 'visible', timeout: 8000 });
  check(Math.abs((await panelWidth()) - after) <= 2, `after a restart the panel is open again at the same width (${await panelWidth()})`);
  check(!!(await waitScreen(/STUB READY/)) && (await starts()) === 3, 'and starts its session again');
} catch (e) {
  check(false, String(e).split('\n')[0]);
  await win.screenshot({ path: join(out, 'error.png') }).catch(() => undefined);
}
check(errors.length === 0, `no page errors${errors.length ? ` (${errors[0]})` : ''}`);
await app.close();
await writeFile(notePath, original);
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
