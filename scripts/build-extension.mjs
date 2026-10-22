// Packs the Claude Desktop extension (.mcpb) with the MCP server and a bundled git (dugite),
// so it works on machines without git. Output: release/smart-doc-link.mcpb
import { execSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const stage = join(repo, 'release', 'extension');
const run = (cmd, cwd = repo) => execSync(cmd, { cwd, stdio: 'inherit' });

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'server'), { recursive: true });
run(`node scripts/build-mcp.mjs "${join(stage, 'server', 'server.mjs')}" --minify`);
await cp(join(repo, 'extension', 'manifest.json'), join(stage, 'manifest.json'));
const dugite = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(repo, 'node_modules', 'dugite', 'package.json'), 'utf8'))).version;
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'smart-doc-link-extension', private: true, type: 'module', dependencies: { dugite } }, null, 2));
run('npm install --omit=dev --no-audit --no-fund', stage);
run(`npx --yes @anthropic-ai/mcpb pack "${stage}" "${join(repo, 'release', 'smart-doc-link.mcpb')}"`);
