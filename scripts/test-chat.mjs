// The Claude panel's chat with a stand-in for Claude Code (scripts/chat-stub.mjs, started through a
// .cmd in a folder with spaces, as an npm install of Claude Code is). Covers: how Claude Code is
// started (stream-json, approvals over stdio, Locus asking whatever mode the user runs, the look
// tools pre-approved, the prompt); a streamed reply with a link that opens its place; looking
// (current_view, screenshot, read_note seeing unsaved typing) with no questions; edit_note asking
// first, Deny and Allow, the change landing in the editor as its own undo step without touching the
// user's typing, Show and Undo (also after typing elsewhere), Allow for this chat; failures said
// plainly; insert_text; cite_selection through Locus's Cite; a file write to an open note refused
// on the spot (pointing at edit_note) while other writes ask; Stop; a sign-in result and a crash
// explained, with the terminal a click away; the chat surviving hide, reload and a crash (resumed);
// New chat; nothing Claude writes drawn as HTML.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-chat.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-chat');
const userData = join(out, 'user-data');
const stubOut = join(out, 'stub.jsonl');
const workspace = resolve(repo, '..', 'locus-test-workspace');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));
const shimDir = join(out, 'Program Files (x86)', 'claude shim');
const shim = join(shimDir, 'claude.cmd');
await mkdir(shimDir, { recursive: true });
await writeFile(shim, `@node "${join(repo, 'scripts', 'chat-stub.mjs')}" %*\r\n`);
// The terminal tab runs the terminal stand-in, so nothing here starts the real Claude Code.
const terminalCmd = ['node', join(repo, 'scripts', 'claude-panel-stub.mjs')];

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
const pidAlive = async (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lastTool = async (name) => (await records()).filter((r) => r.event === 'tool' && r.name.endsWith(name)).pop();
// Chat sessions only (the terminal stand-in writes its own start lines here too).
const starts = async () => (await records()).filter((r) => r.event === 'start' && r.servers);

const errors = [];
const app = await electron.launch({
  args: [repo],
  env: { ...process.env, LOCUS_USER_DATA: userData, LOCUS_CHAT_CMD: JSON.stringify([shim]), LOCUS_TERMINAL_CMD: JSON.stringify(terminalCmd), LOCUS_STUB_OUT: stubOut },
});
let win = await app.firstWindow();
await win.setViewportSize({ width: 1600, height: 900 });
win.on('pageerror', (e) => errors.push(String(e)));

const notePath = join(workspace, 'notes', 'design-basis.md');
const chat = () => win.locator('.claude-panel .chat');
const input = () => win.locator('.chat-input');
const until = async (fn, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await win.waitForTimeout(120);
  }
  return null;
};
/** The open note as the editor has it (unsaved typing included), through the page's own tool. */
const buffer = () => win.evaluate(async () => {
  const r = await window.__locusLive.call('readNote', {});
  return typeof r === 'string' ? r.split('\n').slice(1).map((l) => l.replace(/^\s*\d+\| /, '')).join('\n') : JSON.stringify(r);
});
const idle = () => until(async () => (await win.locator('.chat-compose button', { hasText: 'Send' }).count()) > 0, 15000);
const send = async (text, wait = true) => {
  await input().fill(text);
  await input().press('Enter');
  if (wait) {
    await win.waitForTimeout(150);
    await idle();
  }
};
const asks = () => win.locator('.chat-ask');
const answer = async (label) => {
  await asks().last().waitFor({ timeout: 10000 });
  await asks().last().getByRole('button', { name: label, exact: true }).click();
};
const lastClaude = () => win.locator('.chat-claude').last().textContent();

try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('design-basis');
  await win.locator('.tree-row', { hasText: 'design-basis.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .cm-line').nth(2).waitFor({ timeout: 10000 });

  // ---- The panel opens on the chat ----
  await win.locator('.claude-toggle').click();
  await chat().waitFor({ timeout: 5000 });
  check(await win.locator('.claude-modes [role="tab"][aria-selected="true"]', { hasText: 'Chat' }).isVisible(), 'the Claude panel opens on the chat');
  check((await win.locator('.chat-starters button').count()) === 3, 'an empty chat offers starters');
  check((await starts()).length === 0, 'Claude Code is not started until there is something to send');

  // ---- A reply, streamed, with a link that opens its place ----
  await send('hello', false);
  const streamed = await until(async () => (await win.locator('.chat-claude.streaming').count()) > 0, 5000);
  check(!!streamed, 'the reply shows as it streams in');
  await idle();
  check((await win.locator('.chat-user').last().textContent()) === 'hello', 'the message shows as sent');
  const reply = await lastClaude();
  check(/Hello from the stand-in/.test(reply) && (await win.locator('.chat-claude').last().locator('strong').count()) === 1 && (await win.locator('.chat-claude').last().locator('li').count()) === 2, 'the reply is drawn: bold, code and a list');
  const start = (await starts())[0];
  check(start && resolve(start.cwd) === resolve(workspace), 'Claude Code runs in the workspace folder (through a .cmd in a folder with spaces)');
  const a = start?.args ?? [];
  const after = (f) => a[a.indexOf(f) + 1];
  check(a.includes('-p') && after('--input-format') === 'stream-json' && after('--output-format') === 'stream-json' && a.includes('--include-partial-messages'), 'it is run headless, speaking stream-json');
  check(after('--permission-prompt-tool') === 'stdio' && after('--permission-mode') === 'default', 'approvals come to Locus, whatever mode the user runs Claude Code in');
  check(['current_view', 'read_note', 'screenshot', 'show'].every((t) => after('--allowedTools').split(',').includes(`mcp__locus-live__${t}`)) && !/edit_note|insert_text|cite_selection|save_version/.test(after('--allowedTools')), `only the look tools are pre-approved (${after('--allowedTools')})`);
  check(/edit_note/.test(after('--append-system-prompt')) && /never Write, Edit or write_note/.test(after('--append-system-prompt')), 'the prompt tells Claude how to work in Locus');
  check(start?.servers.includes('locus-live'), `it gets the live tools (${start?.servers.join(', ')})`);
  await win.locator('.chat-claude').last().locator('button.chat-link').click();
  const docTab = await until(async () => {
    const t = await win.evaluate(() => document.querySelector('[data-pane="docs"] .tab.active')?.textContent ?? '');
    return /BDS-100/.test(t) ? t : null;
  });
  check(!!docTab, 'a link in the reply opens its place in the viewer');

  // ---- Looking needs no approval ----
  await send('view');
  check((await asks().count()) === 0, 'current_view runs without asking');
  check(/design-basis\.md and \/docs\/BDS-100/.test(await lastClaude()), `Claude sees the note and the document (${(await lastClaude()).trim()})`);
  check(/Looked at what you have open/.test(await win.locator('.chat-tool').last().textContent()), 'what Claude did shows in plain words');
  await send('shot');
  const shot = await lastTool('screenshot');
  check(shot?.ok && shot.content[0]?.type === 'image' && shot.content[0].mimeType === 'image/jpeg' && shot.content[0].bytes > 5000, `screenshot gives Claude a picture of the window (${shot?.content[0]?.bytes} bytes)`);
  // read_note sees typing that isn't saved yet.
  await win.locator('[data-pane="notes"] .cm-line', { hasText: 'Ultimate factor' }).click();
  await win.keyboard.press('End');
  await win.keyboard.type(' TYPED-BY-USER');
  await send('read');
  const read = await lastTool('read_note');
  check(read?.ok && /design-basis\.md: open in the editor/.test(read.text) && /\d\| # Design basis/.test(read.text) && read.text.includes('TYPED-BY-USER'), 'read_note reads the note as on screen, numbered, unsaved typing included');

  // ---- Changing asks first: Deny ----
  await send('edit launch and landing => launch, ascent and landing', false);
  await asks().first().waitFor({ timeout: 10000 });
  const card = await asks().last().textContent();
  check(/Allow Claude to change the open note\?/.test(card) && (await asks().last().locator('.chat-del').textContent()) === 'launch and landing' && (await asks().last().locator('.chat-ins').textContent()) === 'launch, ascent and landing', 'edit_note asks first, showing the text before and after');
  await answer('Deny');
  await idle();
  check(!(await buffer()).includes('ascent') && /You said no/.test(await win.locator('.chat-asked').last().textContent()), 'Deny leaves the note alone, and says so');
  check((await records()).filter((r) => r.event === 'answer').pop()?.response.behavior === 'deny', 'Claude is told no');

  // ---- Allow: the change lands in the editor, its own undo step ----
  await send('edit launch and landing => launch, ascent and landing', false);
  await answer('Allow');
  await idle();
  let text = await buffer();
  check(text.includes('launch, ascent and landing') && text.includes('TYPED-BY-USER'), 'Allow changes the note in the editor, keeping what the user typed');
  check((await win.locator('[data-pane="notes"] .cm-flash').count()) > 0, 'the change is highlighted');
  const row = win.locator('.chat-tool').filter({ hasText: 'Changed the open note' }).last();
  check((await row.getByRole('button', { name: 'Undo' }).count()) === 1 && (await row.getByRole('button', { name: 'Show' }).count()) === 1, 'the change has Show and Undo in the chat');
  await win.locator('[data-pane="notes"] .cm-line', { hasText: 'Design basis' }).first().click();
  await win.keyboard.press('Control+Z');
  await win.waitForTimeout(300);
  text = await buffer();
  check(!text.includes('ascent') && text.includes('TYPED-BY-USER'), "Ctrl+Z takes back Claude's change alone, not the user's typing");
  await win.keyboard.press('Control+Y');
  await win.waitForTimeout(300);
  check((await buffer()).includes('ascent'), '…and Ctrl+Y puts it back');
  await row.getByRole('button', { name: 'Undo' }).click();
  await win.waitForTimeout(300);
  text = await buffer();
  check(!text.includes('ascent') && text.includes('TYPED-BY-USER') && /\(undone\)/.test(await row.textContent()), 'Undo in the chat takes back the change');

  // Edits sent as JSON text (as some callers do) still show in the card and still apply.
  await send('edit-json metallic parts => metal parts', false);
  check((await asks().last().locator('.chat-del').textContent()) === 'metallic parts', 'edits sent as JSON text show in the card as before and after');
  await answer('Allow');
  await idle();
  check((await buffer()).includes('metal parts.'), '…and apply');

  // Allow for this chat; Undo after the user has typed elsewhere.
  await send('edit Ultimate factor 1.4 => Ultimate factor 1.5', false);
  await answer('Allow for this chat');
  await idle();
  check((await buffer()).includes('Ultimate factor 1.5'), 'Allow for this chat makes the change');
  const before = await asks().count();
  await send('edit Factors of safety => Safety factors');
  check((await asks().count()) === before && (await buffer()).includes('## Safety factors'), '…and the next change of that kind goes ahead without asking');
  await win.locator('[data-pane="notes"] .cm-line', { hasText: 'Design basis' }).first().click();
  await win.keyboard.press('End');
  await win.keyboard.type(' (draft)');
  await win.locator('.chat-tool').filter({ hasText: 'Changed the open note' }).last().getByRole('button', { name: 'Undo' }).click();
  await win.waitForTimeout(300);
  text = await buffer();
  check(text.includes('## Factors of safety') && text.includes('# Design basis (draft)') && text.includes('Ultimate factor 1.5'), 'Undo takes back just that change, even after the user typed elsewhere');
  await win.locator('.chat-tool').filter({ hasText: 'Changed the open note' }).nth(-2).getByRole('button', { name: 'Show' }).click();
  check((await win.locator('[data-pane="notes"] .cm-flash').count()) > 0, 'Show highlights a change again');

  // A change that can't be made is said plainly, and nothing changes.
  const was = await buffer();
  await send('edit text that is not there => anything');
  const failed = await lastTool('edit_note');
  check(!failed.ok && /isn't in/.test(failed.text) && (await buffer()) === was, `an edit that doesn't match changes nothing (${failed.text.slice(0, 70)}…)`);
  check(/didn’t work/.test(await win.locator('.chat-tool').last().textContent()), '…and the chat says it didn’t work');

  // ---- insert_text asks (another kind of change) ----
  await send('insert Inserted by Claude.', false);
  await answer('Allow');
  await idle();
  check((await buffer()).trimEnd().endsWith('Inserted by Claude.'), 'insert_text adds text at the end of the note');

  // ---- cite_selection goes through Locus's Cite ----
  await send('cite', false);
  await answer('Allow');
  await idle();
  const cited = await lastTool('cite_selection');
  check(cited?.ok && /\[BDS-100[^\]]*\]\(<\/docs\/BDS-100 Bracket Design Standard\.pdf#page=\d+&at=[0-9a-f]+>\)/.test(await buffer()), `cite_selection puts in a citation with the version recorded (${(cited?.text ?? '').match(/\[.*\)/)?.[0]})`);
  await send('cite embed', false);
  await answer('Allow');
  await idle();
  check(/!\[BDS-100[^\]]*\]\(<\/docs\/BDS-100 Bracket Design Standard\.pdf#page=\d+&at=/.test(await buffer()), '…or an embedded view');

  // ---- A file write to the open note is refused on the spot; other writes ask ----
  const disk = await readFile(notePath, 'utf8');
  const asked = await asks().count();
  await send('write notes/design-basis.md overwritten');
  const refused = (await records()).filter((r) => r.event === 'answer').pop();
  check(refused?.response.behavior === 'deny' && /edit_note/.test(refused.response.message) && (await asks().count()) === asked, 'writing the open note as a file is refused without asking, pointing Claude at edit_note');
  check((await readFile(notePath, 'utf8')) === disk, '…and the file is untouched');
  const newFile = join(workspace, 'notes', 'chat-new.md');
  await rm(newFile, { force: true });
  await send('write notes/chat-new.md hi', false);
  await answer('Allow');
  await idle();
  check(!!(await stat(newFile).catch(() => null)), 'writing another file asks, and Allow lets it');
  await rm(newFile, { force: true });

  // ---- Stop ----
  await send('slow', false);
  await until(async () => (await win.locator('.chat-claude.streaming').count()) > 0, 5000);
  await win.locator('.chat-compose').getByRole('button', { name: 'Stop' }).click();
  await idle();
  check(/Stopped/.test(await win.locator('.chat-list').textContent()), 'Stop interrupts Claude');
  await send('after stop');
  check(/GOT: after stop/.test(await lastClaude()) && (await starts()).length === 1, '…and the chat goes on in the same session');

  // ---- Nothing Claude writes is drawn as HTML ----
  await send('<img src=x onerror="window.__pwned=1"><b>bold</b>');
  check((await win.locator('.chat-list img, .chat-list b').count()) === 0 && !(await win.evaluate(() => window.__pwned)), 'text that looks like HTML is shown as text');

  // ---- Save a version (asks) ----
  await send('save Chat test version', false);
  check(/save a version named "Chat test version"/.test(await asks().last().textContent()), 'save_version asks first, naming the version');
  await answer('Allow');
  await idle();
  check(/Saved a version named "Chat test version"/.test((await lastTool('save_version'))?.text ?? ''), 'and saves it once allowed');

  // ---- Sign-in: explained, with the terminal a click away ----
  await send('signin');
  const signin = win.locator('.chat-problem.signin').last();
  check((await signin.count()) === 1 && /never handles your sign-in/.test(await signin.textContent()) && /\/login/.test(await signin.textContent()), 'a sign-in problem says what to do, and that Locus never handles the sign-in');
  await signin.getByRole('button', { name: 'Open the terminal' }).click();
  check(await win.locator('.claude-modes [role="tab"][aria-selected="true"]', { hasText: 'Terminal' }).isVisible(), '“Open the terminal” switches to the terminal');
  await win.locator('.claude-modes').getByRole('tab', { name: 'Chat' }).click();

  // ---- Hide, reload: the chat is kept ----
  const count = await win.locator('.chat-user').count();
  await win.locator('.claude-toggle').click();
  await win.locator('.claude-toggle').click();
  check((await win.locator('.chat-user').count()) === count, `hiding the panel keeps the chat (${count} → ${await win.locator('.chat-user').count()})`);
  await win.reload();
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  await win.locator('.claude-panel .chat').waitFor({ timeout: 15000 });
  check(!!(await until(async () => (await win.locator('.chat-user').count()) === count, 8000)), 'reloading the window keeps the chat');
  await send('after reload');
  check(/GOT: after reload/.test(await lastClaude()) && (await starts()).length === 1, '…and the same Claude Code session answers');

  // ---- A crash: explained, and the next message picks the conversation back up ----
  await send('crash');
  const crash = win.locator('.chat-problem.error').last();
  check(/Something broke inside the stand-in/.test(await crash.textContent()), 'when Claude Code stops, the chat says so with what it printed');
  await send('after crash');
  const all = await starts();
  check(all.length === 2 && all[1].resume && /GOT: after crash/.test(await lastClaude()), `the next message starts Claude Code again, resuming the conversation (${all.length} sessions, resume ${all[1]?.resume})`);

  // ---- New chat ----
  await win.locator('.claude-head button[title^="New chat"]').click();
  check(!!(await until(async () => (await win.locator('.chat-user').count()) === 0)), 'New chat clears the conversation');
  await send('fresh');
  const fresh = await starts();
  check(fresh.length === 3 && !fresh[2].resume, '…and starts a new one');
  const ended = await until(async () => (await records()).filter((r) => r.event === 'end').length >= 1 || !(await pidAlive(all[1]?.pid)), 4000);
  check(!!ended, 'the old session was ended');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL', e);
  failures++;
  await win.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
