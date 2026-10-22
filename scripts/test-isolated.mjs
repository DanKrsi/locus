// Tests the shipped servers the way users get them: copied outside the repo so they can't
// borrow anything from its node_modules. The extension is also tested without system git.
// Usage: npm run build:plugin && npm run build:extension && node scripts/test-isolated.mjs
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const dir = await mkdtemp(join(tmpdir(), 'locus-isolated-'));
let failed = false;

function run(name, server, env = {}) {
  execFileSync(process.execPath, [join(repo, 'scripts', 'make-test-workspace.mjs')], { stdio: 'ignore' });
  try {
    const out = execFileSync(process.execPath, [join(repo, 'scripts', 'test-mcp.mjs')], {
      env: { ...process.env, ...env, LOCUS_SERVER: server },
      encoding: 'utf8',
    });
    console.log(`ok   ${name}: ${out.trim().split('\n').pop()}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 3000));
  }
}

await cp(join(repo, 'plugin'), join(dir, 'plugin'), { recursive: true });
run('Claude Code plugin', join(dir, 'plugin', 'server', 'server.mjs'));

await cp(join(repo, 'release', 'extension'), join(dir, 'extension'), { recursive: true });
// Only Node on the PATH: the extension must use its bundled git.
run('Claude Desktop extension (no system git)', join(dir, 'extension', 'server', 'server.mjs'), {
  PATH: dirname(process.execPath),
  Path: dirname(process.execPath),
});

await rm(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
