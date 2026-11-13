// Bundles the MCP server into one file. Git comes from dugite when installed beside it, else the system git.
// The server and the plugin carry the app's version (package.json), so one number says what is installed.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const outfile = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'dist/mcp/server.mjs';

await build({
  entryPoints: ['src/mcp/server.ts'],
  outfile,
  define: { __LOCUS_VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['dugite'],
  loader: { '.md': 'text' },
  minify: process.argv.includes('--minify'),
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

if (outfile.replace(/\\/g, '/').startsWith('plugin/')) {
  const file = 'plugin/.claude-plugin/plugin.json';
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version !== version) writeFileSync(file, JSON.stringify({ ...manifest, version }, null, 2) + '\n');
}
