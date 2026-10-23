# UI spec (v1)

Status: draft · Platform: Windows first · Shell: Electron

A desktop app with notes on the left and the source documents on the right. One click puts a
reference to the exact page, lines, cells or area into the note; clicking it later brings you
straight back. It also knows the workspace's version history, so references can point at any
version of a file.

## 1. Window layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◆ Locus  Bracket project  [Open] [Save version] [Sync] [Share]                  ☀ ⚙ │ header
├──────────────────────────────────────┬───────────────────────────────────────┤
│ [Review.md ●] [Design.md] [+]        │ [spec.pdf] [solver.py · Mar 3] [+ Open]│ tabs
│ Heading▾ B I S </> • 1. ☐ ❝ ▦ 🔗  Tour│ ‹ 22 of 36 › − Fit + │ Area │ [Cite page]│ toolbars
│                                      │ History ●────●───●──────────◉ Latest   │ version strip
│   # Bracket review                   ║                                       │
│   Margins per 📄NASA-STD p18 ...      ║        (PDF / code / sheet)            │
└──────────────────────────────────────┴───────────────────────────────────────┘
```

- Two panes, draggable divider (double-click resets to 50/50; split is remembered).
- Each pane has its own tab row and toolbar; the header spans both.
- Calm, document-first look: white writing surface, lightly tinted page background, 1px
  borders, 6px corners, soft shadows only on floating things.

## 2. Visual design

- All colours are CSS variables. Themes define the same roles: page, panel, border, text,
  muted, accent, accent-soft, highlight (gold), highlight-soft, danger.
- Default theme **Forest** (deep green accent, gold highlight). Others: Ocean, Plum,
  Terracotta, Slate. Every theme has a dark variant; "System" follows Windows.
- UI: Segoe UI 14px. Note body 16px / 1.65, max width ~860px. Code: Cascadia Code / Consolas.

## 3. Header

Logo + name · workspace name (click → open another workspace) · **Open** · **Save version** ·
sync pill and **Share** (when shared) · light/dark toggle · settings ⚙. Ctrl+P opens the file browser
like **Open**; Ctrl+O opens a note.

**Open** shows the file browser (the same one as Ctrl+P), with a selector for the version to
show the folder as it was. Its **Version history** button leads to the history: the workspace's
versions, and for the selected one what it changed (added, changed, moved, deleted files).
Clicking a file there opens it as it was in that version; **Browse all files from this version**
and **Back to files** return to the file browser. There is no global "viewing an old
version" mode: each document tab carries its own version (badge on the tab, version strip under
the toolbar), and the file browser's version selector resets to Latest each time it opens.

## 4. Left pane: notes

- Note tabs (● = unsaved), middle-click closes, drag to reorder, + new note.
- Formatting toolbar: paragraph/heading dropdown, bold, italic, strikethrough, inline code,
  code block, bullet/numbered/task list, quote, table, horizontal rule, link, undo/redo;
  right side: **Link to section** and **Tour**.
- Editor: Obsidian-style **live preview** (CodeMirror 6). Markdown renders in place; the raw
  syntax of the line you're on is revealed. Markdown shortcuts work as you type.
- The file on disk is the source of truth: only edited lines change; line endings and
  encoding are preserved. Autosave after a pause, with a small "Saved" toast.

### 4.1 References in the note

- Accent colour, medium weight, no underline until hover, small icon by type (PDF page, code,
  grid for cells, # for notes, play for media).
- **Pinned** references show a small date badge (Simple mode) or short SHA (Git mode).
- Broken references: red wavy underline with the reason; `moved` ones offer **Fix links**.
- **Hover card** (~400ms): preview (page thumbnail with the area drawn, code lines with
  numbers, mini table of cells) · file name and folder · location description · version
  ("Version from Mar 3 · changed since") · quote in italics · buttons **Open**, **Compare with
  latest** (pinned only), **Rename**, **Edit target**, **Remove link**.
- Click → opens the document on the right at the location, scrolled into view, highlighted.

### 4.2 Citing

- **Cite** button at the far right of the viewer toolbar (gold), label depends on the view:
  Cite page / Cite area / Cite lines / Cite range / Cite time. Shortcut **Ctrl+Shift+L**.
- Inserts the reference at the cursor (see link-format §3 for the label rules) and opens an
  inline rename box over the label: label pre-selected, 2px accent border, hint
  "Enter to name · Esc keeps '<default>'". Typing replaces, Enter confirms.
- **Drag to cite**: drag a selection from the viewer into the note.

### 4.3 Tour mode

Steps through the note's references in order with ←/→ (or PageUp/PageDown); the viewer
follows and the current reference is highlighted in the note. Esc exits.

## 5. Right pane: documents

- Document tabs show a version badge when not on the latest version. **+ Open** opens the
  file browser (workspace tree + version picker); external files are allowed and marked.
- Empty state: "No document open", **Open file** button, recent files.
- Every tab keeps its own scroll, zoom, search and version.
- **Version strip** under the toolbar: one dot per version of this file, current one
  highlighted, gold dots for versions cited by the open note. Click a dot to view that version.
- **"Cited in" markers**: gold bookmarks in the page margin / gutter where any note in the
  workspace cites this document; hover lists the notes.

### 5.1 Viewers

| Viewer | Behaviour |
|---|---|
| PDF | Grey background, white pages, page box (printed labels supported), zoom, search, **Area** tool (crosshair, drag a translucent gold box; Esc cancels), text selection becomes the quote |
| Code / text | Read-only, syntax highlighted, line numbers; cited lines get a pale gold band |
| Spreadsheet | Excel-like grid: column letters / row numbers, column widths, merged cells, fills, bold, number formats, sheet tabs at the bottom; name box + formula bar; virtualised rendering |
| Markdown | Rendered; headings can be cited |
| Image | Fit / zoom; Area tool |
| Audio / video | Player; Cite time |
| Compare | Two versions of a file side by side (code: diff view) |

## 6. Settings

- **Terminology**: *Simple* (default) or *Git*. Changes words only, never behaviour, except
  that Git mode also shows branches, SHAs and separate Pull/Push buttons.

| Simple | Git |
|---|---|
| Version | Commit |
| Save version | Commit |
| Automatic version | Auto-commit (snapshot) |
| Version history | Log |
| Not saved in a version yet | Uncommitted changes |
| Latest | HEAD / working tree |
| Pinned to Mar 3 | Pinned to `3f2a9c1` |
| Sync | Pull + Push |
| Changes to share | Commits ahead |
| Updates available | Commits behind |
| Online copy | Remote (`origin`) |
| Download workspace | Clone |
| Share as file (.locus) | Export git bundle |
| Keep mine / Keep theirs | Resolve: ours / theirs |
| Workspace | Repository |

- Theme, autosave, auto-sync, Git: built-in or system git, GitHub account.

## 7. Sharing (later milestone)

Share → sign in with GitHub (device code) → private repo created → invite by username/email →
copy open link. Sync pill: Synced / Changes to share / Updates available. Conflicts on notes
are shown side by side (Keep mine / Keep theirs / Keep both); binary conflicts keep both
copies. Single-file `.locus` package (git bundle) for sharing without accounts.

## 8. Keyboard shortcuts

| Action | Keys |
|---|---|
| Save | Ctrl+S |
| New note / Open workspace | Ctrl+N / Ctrl+O |
| Quick open file | Ctrl+P |
| Headings | Ctrl+0 … Ctrl+6 |
| Bold / Italic | Ctrl+B / Ctrl+I |
| Cite what's shown on the right | Ctrl+Shift+L |
| Link to a section of a note | Ctrl+Alt+L |
| Search open document | Ctrl+F |
| Tour mode | Ctrl+Shift+T |
| Save version | Ctrl+Shift+S |
| Shortcuts | F1 |
