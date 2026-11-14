// The look of an exported note: one stylesheet used by the web-page export, the PDF export and
// the viewer people without Locus get, so all three read the same way.

export const NOTE_CSS = `
:root {
  --page: #fdfdfb; --panel: #ffffff; --text: #22272a; --muted: #5d676d; --faint: #8a9499;
  --border: #e3e6e2; --accent: #1f5c45; --accent-soft: #eaf1ed; --highlight: #c9a227;
  --highlight-soft: #fbf3d8; --code-bg: #f5f6f4;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--text);
  font: 16px/1.65 'Segoe UI', -apple-system, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.note { max-width: 820px; margin: 0 auto; padding: 32px 28px 64px; }
.note > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; }
h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1.05em; }
p { margin: 0.7em 0; }
a { color: var(--accent); text-decoration: none; font-weight: 500; }
a:hover { text-decoration: underline; }
ul, ol { margin: 0.7em 0; padding-left: 1.5em; }
li { margin: 0.25em 0; }
li.task { list-style: none; margin-left: -1.3em; }
li.task input { margin-right: 6px; accent-color: var(--accent); }
blockquote {
  margin: 0.9em 0; padding: 0.1em 0 0.1em 14px;
  border-left: 3px solid var(--border); color: var(--muted);
}
code { font-family: 'Cascadia Code', Consolas, monospace; font-size: 0.88em; background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 3px; }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
pre code { background: none; border: 0; padding: 0; font-size: 0.86em; }
hr { border: 0; border-top: 1px solid var(--border); margin: 1.6em 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
table { border-collapse: collapse; margin: 0.9em 0; font-size: 0.95em; }
th, td { border: 1px solid var(--border); padding: 5px 10px; text-align: left; vertical-align: top; }
th { background: var(--accent-soft); font-weight: 600; }
.export-head { max-width: 820px; margin: 0 auto; padding: 22px 28px 0; color: var(--faint); font-size: 12.5px; }
@media print {
  body { background: #fff; }
  .note { padding: 0; max-width: none; }
  .export-head { padding: 0 0 12px; max-width: none; }
  a { color: var(--accent); }
  pre, blockquote, table, img { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`.trim();

export interface PageOptions {
  title: string;
  /** The rendered note. */
  body: string;
  /** A line above the note saying where it came from. */
  note?: string;
  /** Extra CSS, and markup after the note (the viewer adds its own). */
  css?: string;
  head?: string;
  after?: string;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** A complete HTML document for an exported note. */
export function buildPage(o: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<style>
${NOTE_CSS}
${o.css ?? ''}
</style>
${o.head ?? ''}
</head>
<body>
${o.note ? `<div class="export-head">${esc(o.note)}</div>` : ''}
<main class="note">
${o.body}
</main>
${o.after ?? ''}
</body>
</html>
`;
}
