// "Export for someone without Locus": a folder holding the note, the files it cites, and a
// viewer that opens them at the cited place. It runs from a disk or an email attachment with no
// install and no server, so every file travels inside the folder as a script the page loads.
import { promises as fs } from 'node:fs';
import { basename as pathBase, dirname, join } from 'node:path';
import { basename, extname, fileKind, parseDestination, resolvePath, slugify, stem, type Location } from '../core/link';
import { isCanvas } from '../core/canvas';
import { extractLinks } from '../core/mdlinks';
import { renderMarkdown, escapeHtml } from '../core/render';
import { splitNoteId } from '../core/noteid';
import * as git from './git';

/** How much the whole export may come to, and how many notes it may carry. */
export const LIMITS = { bytes: 1.5e9, notes: 400 };

export interface PlanFile {
  /** Workspace path, or an absolute path for a file outside the workspace. */
  path: string;
  /** The version a link cited, when it isn't the latest. */
  rev?: string;
  revLabel?: string;
  outside: boolean;
  size: number;
  /** Set when the file could not be read: the viewer says so instead of opening it. */
  missing?: boolean;
}

export interface PlanNote {
  path: string;
  title: string;
  markdown: string;
}

export interface ExportPlan {
  main: string;
  notes: PlanNote[];
  files: PlanFile[];
  /** Flowcharts and other files the viewer can't draw, carried as plain copies only. */
  scope: 'linked' | 'workspace';
  /** Everything the folder will hold, in bytes. */
  bytes: number;
  tooBig: boolean;
}

const key = (path: string, rev?: string) => (rev ? `${path}@${rev}` : path);

/** A date a person can read, for the version badge on a tab. */
function revLabel(date: string | undefined, rev: string): string {
  if (!date) return rev.slice(0, 7);
  return new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface PlanContext {
  root: string;
  notePath: string;
  /** The note as it is on screen, which may differ from the file. */
  markdown: string;
  scope: 'linked' | 'workspace';
}

const readWorkspaceFile = async (root: string, path: string, rev?: string): Promise<Uint8Array> =>
  rev ? git.readBlob(root, path, rev) : fs.readFile(join(root, path.slice(1)));

/** Walks the note and the notes it links to, listing everything the folder must carry. */
export async function planExport(ctx: PlanContext): Promise<ExportPlan> {
  const notes: PlanNote[] = [];
  const files = new Map<string, PlanFile>();
  const seenNotes = new Set<string>();
  const queue: { path: string; markdown?: string }[] = [{ path: ctx.notePath, markdown: ctx.markdown }];
  const dates = new Map<string, string | undefined>();

  while (queue.length && notes.length < LIMITS.notes) {
    const next = queue.shift()!;
    if (seenNotes.has(next.path)) continue;
    seenNotes.add(next.path);
    let md = next.markdown;
    if (md === undefined) {
      md = await fs.readFile(join(ctx.root, next.path.slice(1)), 'utf8').catch(() => undefined);
      if (md === undefined) continue;
    }
    const body = splitNoteId(md).body;
    notes.push({ path: next.path, title: stem(next.path), markdown: body });

    for (const link of extractLinks(body)) {
      const ref = parseDestination(link.dest);
      if (!ref || ref.pathKind === 'web' || !ref.path) continue;
      const outside = ref.pathKind === 'external';
      const path = outside ? ref.path : resolvePath(ref, next.path);
      // Another note is read as it is now, and brings its own links with it.
      if (!outside && !ref.rev && fileKind(path) === 'markdown') {
        if (!seenNotes.has(path)) queue.push({ path });
        continue;
      }
      // A picture shown in the note is already inside the page.
      if (link.image) continue;
      const k = key(path, ref.rev);
      if (files.has(k)) continue;
      let size = 0;
      let missing = false;
      try {
        const bytes = outside ? await fs.readFile(path) : await readWorkspaceFile(ctx.root, path, ref.rev);
        size = bytes.length;
      } catch {
        missing = true;
      }
      if (ref.rev && !dates.has(ref.rev)) {
        const v = await git.log(ctx.root).catch(() => []);
        for (const one of v) dates.set(one.sha.slice(0, 10), one.date);
      }
      files.set(k, { path, rev: ref.rev, revLabel: ref.rev ? revLabel(dates.get(ref.rev), ref.rev) : undefined, outside, size, missing });
    }
  }

  let bytes = [...files.values()].reduce((n, f) => n + f.size, 0);
  if (ctx.scope === 'workspace') {
    for (const p of await git.listWorking(ctx.root).catch(() => [])) {
      if (p.startsWith('/.locus/')) continue;
      bytes += await fs.stat(join(ctx.root, p.slice(1))).then((s) => s.size, () => 0);
    }
  } else {
    // The plain copies are a second copy of the same files.
    bytes *= 2;
  }
  return { main: ctx.notePath, notes, files: [...files.values()], scope: ctx.scope, bytes, tooBig: bytes > LIMITS.bytes };
}

/** The note as the viewer shows it: links carry what they point at, pictures travel inside. */
function noteHtml(note: PlanNote, plan: ExportPlan, images: Map<string, string>): string {
  const has = new Set(plan.files.filter((f) => !f.missing).map((f) => key(f.path, f.rev)));
  const noteSet = new Set(plan.notes.map((n) => n.path));
  return renderMarkdown(note.markdown, {
    headingId: slugify,
    img: (dest) => images.get(dest) ?? null,
    href: (dest) => {
      const ref = parseDestination(dest);
      if (!ref) return null;
      if (ref.pathKind === 'web') return dest;
      if (!ref.path) return ref.loc.heading ? `#${ref.loc.heading}` : null;
      return '#';
    },
    linkAttrs: (dest) => {
      const ref = parseDestination(dest);
      if (!ref || ref.pathKind === 'web' || !ref.path) return '';
      const path = ref.pathKind === 'external' ? ref.path : resolvePath(ref, note.path);
      const isNote = !ref.rev && noteSet.has(path);
      const loc: Location = ref.loc;
      const attrs = [`data-path="${escapeHtml(path)}"`, `data-loc="${escapeHtml(JSON.stringify(loc))}"`];
      if (ref.rev) attrs.push(`data-rev="${escapeHtml(ref.rev)}"`);
      if (!isNote && !has.has(key(path, ref.rev))) attrs.push('data-missing="1"');
      return attrs.join(' ');
    },
  });
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

/** Pictures shown in a note, as data URIs. */
async function imagesOf(note: PlanNote, root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const link of extractLinks(note.markdown)) {
    if (!link.image || out.has(link.dest)) continue;
    const ref = parseDestination(link.dest);
    if (!ref) continue;
    if (ref.pathKind === 'web') {
      out.set(link.dest, link.dest);
      continue;
    }
    const path = ref.pathKind === 'external' ? ref.path : resolvePath(ref, note.path);
    const type = MIME[extname(path)];
    if (!type) continue;
    try {
      const bytes = ref.pathKind === 'external' ? await fs.readFile(path) : await readWorkspaceFile(root, path, ref.rev);
      out.set(link.dest, `data:${type};base64,${Buffer.from(bytes).toString('base64')}`);
    } catch {
      /* left out */
    }
  }
  return out;
}

const VIEWER_DIR = 'Locus viewer';

/** A name the recipient will understand, including the version when a link cited an old one. */
function copyName(f: PlanFile): string {
  const name = basename(f.path);
  if (!f.rev) return name;
  const ext = extname(name);
  return `${stem(name)} (version ${f.revLabel ?? f.rev.slice(0, 7)})${ext ? '.' + ext : ''}`;
}

export interface ExportResult {
  folder: string;
  files: number;
  notes: number;
  failed: string[];
}

/**
 * Writes the folder. `viewerJs` is the viewer bundle that ships inside Locus; `dest` is a folder
 * that does not exist yet.
 */
export async function writeExport(ctx: PlanContext, plan: ExportPlan, dest: string, viewerJs: string, workspaceName: string): Promise<ExportResult> {
  const viewerDir = join(dest, VIEWER_DIR);
  await fs.mkdir(viewerDir, { recursive: true });
  const failed: string[] = [];

  // 1. Every file the note cites, as a script the page can load from a disk.
  const parts: string[] = [];
  let n = 0;
  for (const f of plan.files) {
    if (f.missing) continue;
    let bytes: Uint8Array;
    try {
      bytes = f.outside ? await fs.readFile(f.path) : await readWorkspaceFile(ctx.root, f.path, f.rev);
    } catch {
      failed.push(f.path);
      f.missing = true;
      continue;
    }
    const name = `data-${++n}.js`;
    const line = `window.LOCUS_FILES=window.LOCUS_FILES||{};window.LOCUS_FILES[${JSON.stringify(key(f.path, f.rev))}]="${Buffer.from(bytes).toString('base64')}";\n`;
    await fs.writeFile(join(viewerDir, name), line, 'utf8');
    parts.push(name);
  }

  // 2. The notes, rendered as the viewer shows them.
  const notes: Record<string, { path: string; title: string; html: string }> = {};
  for (const note of plan.notes) {
    notes[note.path] = { path: note.path, title: note.title, html: noteHtml(note, plan, await imagesOf(note, ctx.root)) };
  }
  const data = {
    workspace: workspaceName,
    main: plan.main,
    exported: new Date().toISOString(),
    notes,
    files: Object.fromEntries(plan.files.map((f) => [key(f.path, f.rev), { path: f.path, rev: f.rev, revLabel: f.revLabel, copy: f.missing ? undefined : copyName(f) }])),
  };
  await fs.writeFile(join(viewerDir, 'export.js'), `window.LOCUS_EXPORT=${JSON.stringify(data)};\n`, 'utf8');
  await fs.writeFile(join(viewerDir, 'viewer.js'), viewerJs, 'utf8');

  // 3. The page to double-click.
  const title = stem(plan.main);
  const scripts = ['export.js', ...parts, 'viewer.js'].map((f) => `<script src="${VIEWER_DIR.replace(/ /g, '%20')}/${f}"></script>`).join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="root"></div>
${scripts}
</body>
</html>
`;
  await fs.writeFile(join(dest, `START HERE - ${title.replace(/[<>:"/\\|?*]/g, '')}.html`), html, 'utf8');

  // 4. Plain copies, in the formats the files are in.
  let copied = 0;
  if (plan.scope === 'workspace') {
    const folder = join(dest, workspaceName.replace(/[<>:"/\\|?*]/g, '') || 'Workspace');
    for (const p of await git.listWorking(ctx.root).catch(() => [])) {
      if (p.startsWith('/.locus/') || /\.(md|canvas)$/i.test(p)) continue;
      const to = join(folder, p.slice(1));
      await fs.mkdir(dirname(to), { recursive: true });
      await fs.copyFile(join(ctx.root, p.slice(1)), to).then(() => copied++, () => failed.push(p));
    }
    const outside = plan.files.filter((f) => f.outside && !f.missing);
    for (const f of outside) {
      const to = join(dest, 'Outside the workspace', pathBase(f.path));
      await fs.mkdir(dirname(to), { recursive: true });
      await fs.copyFile(f.path, to).then(() => copied++, () => failed.push(f.path));
    }
    // Older versions a link cites are not in the folder above.
    for (const f of plan.files.filter((x) => x.rev && !x.missing && !x.outside)) {
      const to = join(folder, dirname(f.path).slice(1), copyName(f));
      await fs.mkdir(dirname(to), { recursive: true });
      await fs.writeFile(to, await readWorkspaceFile(ctx.root, f.path, f.rev)).then(() => copied++, () => failed.push(f.path));
    }
  } else {
    const folder = join(dest, 'Original files');
    await fs.mkdir(folder, { recursive: true });
    for (const f of plan.files) {
      if (f.missing || isCanvas(f.path)) continue;
      const to = join(folder, copyName(f));
      try {
        await fs.writeFile(to, f.outside ? await fs.readFile(f.path) : await readWorkspaceFile(ctx.root, f.path, f.rev));
        copied++;
      } catch {
        failed.push(f.path);
      }
    }
  }
  return { folder: dest, files: copied, notes: plan.notes.length, failed };
}
