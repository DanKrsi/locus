// Renders a note to HTML, for exports and for the viewer people without Locus get. The markdown
// is parsed with the same grammar the editor uses, so what comes out matches what was on screen.
import { parser as baseParser, GFM } from '@lezer/markdown';
import type { SyntaxNode, Tree } from '@lezer/common';
import { splitLinkTarget } from './link.ts';

const parser = baseParser.configure(GFM);

export interface RenderOptions {
  /** Where a link goes in the export; null draws its text without a link. */
  href(dest: string, title?: string): string | null;
  /** Where a picture comes from; null leaves the picture out. */
  img(dest: string): string | null;
  /** Added to every link (`target="_blank"`, say). */
  linkAttrs?(dest: string): string;
  /** The id for a heading, for section links. Defaults to the GitHub slug. */
  headingId?(text: string): string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const kids = (n: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
};

/** A link or picture node, split into its parts. */
function linkParts(md: string, node: SyntaxNode) {
  const marks = kids(node).filter((c) => c.name === 'LinkMark');
  const url = kids(node).find((c) => c.name === 'URL');
  const titleNode = kids(node).find((c) => c.name === 'LinkTitle');
  const close = marks.find((m) => md.slice(m.from, m.to) === ']');
  if (!marks.length || !close) return null;
  const labelFrom = marks[0].to;
  const labelTo = close.from;
  // A reference without "(...)" is not one Locus writes; treat it as text.
  if (!url) return null;
  const inner = md.slice(url.from, titleNode ? titleNode.to : url.to);
  const { dest, title } = splitLinkTarget(inner);
  return { labelFrom, labelTo, dest, title };
}

const WIDTH = /[#&]w=(\d+)(?:&|$)/;

export function renderMarkdown(md: string, opts: RenderOptions): string {
  const tree: Tree = parser.parse(md);
  const headingId = opts.headingId ?? ((t: string) => t.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-'));
  const text = (from: number, to: number) => escapeHtml(md.slice(from, to));

  /** Everything between `from` and `to`, with the node's own children rendered. */
  const inline = (node: SyntaxNode, from: number, to: number): string => {
    let out = '';
    let pos = from;
    for (const child of kids(node)) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > pos) out += text(pos, child.from);
      out += renderInline(child);
      pos = child.to;
    }
    return out + text(pos, to);
  };

  const insideMarks = (node: SyntaxNode, markName: string) => {
    const marks = kids(node).filter((c) => c.name === markName);
    const from = marks.length ? marks[0].to : node.from;
    const to = marks.length > 1 ? marks[marks.length - 1].from : node.to;
    return { from, to };
  };

  const renderInline = (node: SyntaxNode): string => {
    switch (node.name) {
      case 'Emphasis': {
        const r = insideMarks(node, 'EmphasisMark');
        return `<em>${inline(node, r.from, r.to)}</em>`;
      }
      case 'StrongEmphasis': {
        const r = insideMarks(node, 'EmphasisMark');
        return `<strong>${inline(node, r.from, r.to)}</strong>`;
      }
      case 'Strikethrough': {
        const r = insideMarks(node, 'StrikethroughMark');
        return `<del>${inline(node, r.from, r.to)}</del>`;
      }
      case 'InlineCode': {
        const r = insideMarks(node, 'CodeMark');
        return `<code>${text(r.from, r.to)}</code>`;
      }
      case 'Link': {
        const p = linkParts(md, node);
        if (!p) return text(node.from, node.to);
        const label = inline(node, p.labelFrom, p.labelTo);
        const href = opts.href(p.dest, p.title);
        if (!href) return label;
        const attrs = opts.linkAttrs?.(p.dest) ?? '';
        const title = p.title ? ` title="${escapeHtml(p.title)}"` : '';
        return `<a href="${escapeHtml(href)}"${title}${attrs ? ' ' + attrs : ''}>${label}</a>`;
      }
      case 'Image': {
        const p = linkParts(md, node);
        if (!p) return text(node.from, node.to);
        const src = opts.img(p.dest);
        if (!src) return '';
        const w = p.dest.match(WIDTH);
        const alt = escapeHtml(md.slice(p.labelFrom, p.labelTo));
        return `<img src="${escapeHtml(src)}" alt="${alt}"${w ? ` width="${w[1]}"` : ''}>`;
      }
      case 'URL':
        return `<a href="${escapeHtml(md.slice(node.from, node.to))}">${text(node.from, node.to)}</a>`;
      case 'Escape':
        return text(node.from + 1, node.to);
      case 'HardBreak':
        return '<br>';
      case 'Entity':
        return md.slice(node.from, node.to);
      default:
        return text(node.from, node.to);
    }
  };

  /** The alignment of each column, from the `|---|--:|` row. */
  const alignments = (row: SyntaxNode): (string | null)[] =>
    md
      .slice(row.from, row.to)
      .split('|')
      .slice(1, -1)
      .map((c) => {
        const t = c.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });

  const blocks = (nodes: SyntaxNode[]): string => nodes.map(renderBlock).join('\n');

  const renderBlock = (node: SyntaxNode): string => {
    switch (node.name) {
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6': {
        const level = Number(node.name.slice(-1));
        const marks = kids(node).filter((c) => c.name === 'HeaderMark');
        const from = marks.length ? marks[0].to : node.from;
        const to = marks.length > 1 ? marks[marks.length - 1].from : node.to;
        const body = inline(node, from, to).trim();
        const id = headingId(md.slice(from, to).trim());
        return `<h${level} id="${escapeHtml(id)}">${body}</h${level}>`;
      }
      case 'SetextHeading1':
      case 'SetextHeading2': {
        const level = node.name.endsWith('1') ? 1 : 2;
        const mark = kids(node).find((c) => c.name === 'HeaderMark');
        const to = mark ? mark.from : node.to;
        const body = inline(node, node.from, to).trim();
        return `<h${level} id="${escapeHtml(headingId(md.slice(node.from, to).trim()))}">${body}</h${level}>`;
      }
      case 'Paragraph':
        return `<p>${inline(node, node.from, node.to).trim()}</p>`;
      case 'Blockquote':
        return `<blockquote>${blocks(kids(node).filter((c) => c.name !== 'QuoteMark'))}</blockquote>`;
      case 'BulletList':
        return `<ul>${blocks(kids(node))}</ul>`;
      case 'OrderedList': {
        const first = kids(node)[0];
        const mark = first && kids(first).find((c) => c.name === 'ListMark');
        const start = mark ? parseInt(md.slice(mark.from, mark.to), 10) : 1;
        return `<ol${start && start !== 1 ? ` start="${start}"` : ''}>${blocks(kids(node))}</ol>`;
      }
      case 'ListItem': {
        const inner = kids(node).filter((c) => c.name !== 'ListMark');
        const task = inner.find((c) => c.name === 'Task');
        if (task) {
          const marker = kids(task).find((c) => c.name === 'TaskMarker');
          const done = marker ? /x/i.test(md.slice(marker.from, marker.to)) : false;
          const from = marker ? marker.to : task.from;
          const body = inline(task, from, task.to).trim();
          return `<li class="task"><input type="checkbox" disabled${done ? ' checked' : ''}> ${body}</li>`;
        }
        // A tight item (one paragraph) reads better without the paragraph's spacing.
        if (inner.length === 1 && inner[0].name === 'Paragraph') return `<li>${inline(inner[0], inner[0].from, inner[0].to).trim()}</li>`;
        return `<li>${blocks(inner)}</li>`;
      }
      case 'FencedCode':
      case 'CodeBlock': {
        const info = kids(node).find((c) => c.name === 'CodeInfo');
        const body = kids(node).find((c) => c.name === 'CodeText');
        const code = body ? text(body.from, body.to) : text(node.from, node.to);
        const lang = info ? ` class="language-${escapeHtml(md.slice(info.from, info.to))}"` : '';
        return `<pre><code${lang}>${code}</code></pre>`;
      }
      case 'HorizontalRule':
        return '<hr>';
      case 'Table': {
        const rows = kids(node);
        const delim = rows.find((r) => r.name === 'TableDelimiter' && md.slice(r.from, r.to).includes('-'));
        const align = delim ? alignments(delim) : [];
        const cell = (c: SyntaxNode, i: number, tag: 'th' | 'td') => {
          const a = align[i] ? ` style="text-align:${align[i]}"` : '';
          return `<${tag}${a}>${inline(c, c.from, c.to).trim()}</${tag}>`;
        };
        const row = (r: SyntaxNode, tag: 'th' | 'td') =>
          `<tr>${kids(r)
            .filter((c) => c.name === 'TableCell')
            .map((c, i) => cell(c, i, tag))
            .join('')}</tr>`;
        const head = rows.find((r) => r.name === 'TableHeader');
        const body = rows.filter((r) => r.name === 'TableRow');
        return `<table>${head ? `<thead>${row(head, 'th')}</thead>` : ''}<tbody>${body.map((r) => row(r, 'td')).join('')}</tbody></table>`;
      }
      case 'HTMLBlock':
      case 'Comment':
        // Never pass raw HTML from a note into the export.
        return '';
      default:
        return node.firstChild ? blocks(kids(node)) : `<p>${text(node.from, node.to).trim()}</p>`;
    }
  };

  return blocks(kids(tree.topNode)).trim();
}
