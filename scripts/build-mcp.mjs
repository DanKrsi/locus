// Bundles the MCP server into one file. Git comes from dugite when installed beside it, else the system git.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/mcp/server.ts'],
  outfile: process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'dist/mcp/server.mjs',
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
