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
│ [Review.md ●] [Design.md] [+]        │ [spec.pdf] [solver.py · Mar 3]        │ tabs
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

### 2.1 Zoom

The notes editor and the document viewers zoom separately (50%–300%), each with **− 100% +**
controls: in the notes tab row, and in each viewer's toolbar (PDFs keep their own zoom steps
and Fit width). Ctrl+= / Ctrl+− zoom the pane last clicked or typed in, and Ctrl+wheel (or a
touchpad pinch) zooms the pane under the pointer; the window itself never zooms. Clicking the
percentage returns to 100% (Ctrl+0 stays "normal text" in notes). Both levels are remembered.

## 3. Header

Logo + name · workspace name (click → open another workspace) · **Open** · **Save version** ·
sync pill and **Share** (when shared) · light/dark toggle · settings ⚙. **Open** is the only way
to open files (the panes have no Open buttons of their own); Ctrl+O and Ctrl+P open it too.

Where a file opens depends on its type. Notes (`.md`) and flowcharts (`.canvas`) ask first:
**Edit** (E or Enter) opens it on the left to write and cite in; **View** (V) opens it read-only
on the right, beside your notes, with an **Edit** button to move it to the left. Anything else
opens in the viewer on the right. Old versions always open on the right.

**Open** shows the file browser, with a selector for the version to
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
- Editor: a **formatted view** (CodeMirror 6). Markdown renders in place and its markup stays
  hidden while editing; the cursor steps over hidden markup. Markdown shortcuts work as you type.
  A link's label is ordinary text: Backspace and typing inside it edit it, deleting its last
  letter removes the link, and typing at its end writes after the link. Backspace at the start
  of a heading, bullet, task or quote removes that formatting. **Edit target** in a link's hover
  card shows that link's markdown until the cursor leaves it.
- Tables are always shown as tables, including straight after **Table** inserts one. Clicking a
  cell edits it in place (same formatted view); Tab / Shift+Tab and Enter move between cells,
  Tab from the last cell adds a row, Esc finishes. While a cell is edited, buttons under the
  table insert a row above or below, a column left or right, or delete the row, column or table.
- The file on disk is the source of truth: only edited lines change; line endings and
  encoding are preserved. Autosave after a pause, with a small "Saved" toast.

### 4.1 References in the note

- Accent colour, medium weight, no underline until hover, small icon by type (PDF page, code,
  grid for cells, # for notes, play for media).
- **Pinned** references show a small date badge (Simple mode) or short SHA (Git mode).
- **Live** references whose cited content changed since they were cited show a red **changed**
  badge: cited code lines edited or deleted (lines that only moved don't count), a quoted PDF
  passage moved to another page or gone, or for other files any change to the file.
- Broken references: red wavy underline with the reason; `moved` ones offer **Fix links**.
- **Hover card** (~400ms): preview (page thumbnail with the area drawn, code lines with
  numbers, mini table of cells) · file name and folder · location description · kind
  ("Live · shows the latest version · cited Mar 3" or "Pinned · always shows the version from
  Mar 3") · what changed, if anything · quote in italics · buttons **Open**, **Compare with
  latest** and **Make live** (pinned), **Compare with cited version** (live, changed) and
  **Pin to this version** / **Pin to cited version** (live), **Rename**, **Edit target**,
  **Remove link**.
- Click → opens the document on the right at the location, highlighted, and always placed the
  same way: the cited area, lines, cells or slide centred in the view (one taller than the view
  starts at its top; a page alone shows the top of the page), as far as the document can scroll.
  If the view is already there (a short file, or the place already on screen), nothing travels:
  the cited highlight pulses once. A
  live link whose content changed opens the latest version with a notice saying so, with
  **Compare** and **Show the cited version**; a quoted PDF passage that moved is found on its
  new page.

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

### 4.4 Flowcharts

The left pane also opens flowcharts: `.canvas` files in the open JSON Canvas format (the one
Obsidian's Canvas uses), so they open in Obsidian too. Locus adds fields Obsidian ignores: box
`shape`, and for arrows `route`, `style` and bend `points`. Files are written one box or arrow
per line, so diffs stay readable.

- **New flowchart** (flowchart icon in the tab row, or the empty pane). **Open** offers
  flowcharts like notes (Edit or View); links to a `.canvas` file open it on the left.
- **Boxes**: process, decision, start/end, input/output, sub-process, note. Add from the
  toolbar (the new box's text is selected, so typing replaces it); change the shape of a selected
  box from the toolbar; drag to move (snaps to an 8 px grid), drag the corners to resize.
- **Box text** is markdown with citations, edited in place with the notes editor (double-click or
  Enter; Esc or clicking away finishes). Citations show as in notes, with version and **changed**
  badges; clicking one opens what it cites.
- **Cite** on the right puts the citation in the box being edited, else the selected box (on a new
  line), else a new box — with the usual rename box.
- **Loop frames** (groups) carry the boxes and frames inside them when moved; frames nest.
  Double-click the title to rename. Arrows can start or end on a frame.
- **Arrows**: drag from a side dot of one box to a side dot of another. Select an arrow to set
  straight / elbow / curve, dashed, arrowheads, and a label (or double-click it). A selected arrow
  shows its bend points (drag to move, double-click to remove) and dashed "+" handles that add a
  bend where dragged.
- Undo / redo (Ctrl+Z / Ctrl+Y), Delete, Fit to view, autosave. Wheel pans; Ctrl+wheel, pinch or
  the tab-row zoom control zoom the view.
- Flowchart citations appear in **Cited in** (picking one shows and flashes the box) and are
  updated when a cited file is renamed in the app.
- Claude drafts flowcharts with the MCP tool `write_flowchart`: boxes in reading order (with `cite`
  options like `make_reference`), loops and arrows; ELK lays them out (loop-backs routed dashed up
  the loop side) and every citation is verified.
- Not yet: tour mode, hover cards and Fix links for flowcharts.

## 5. Right pane: documents

- Document tabs show a version badge when not on the latest version. Files come from the
  header's **Open**; external files are allowed and marked.
- Empty state: "No document open", pointing to **Open**.
- Notes and flowcharts chosen with **View** show read-only here: links, hover cards and
  **Cite lines** / **Cite flowchart** work, nothing can be edited, and **Edit** opens them on
  the left.
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
| Compare | Two versions of a file side by side (code: diff view). A bar above the halves has a **Left** and a **Right** dropdown (Latest or any version of the file), a ⇄ swap button and **Stop comparing**. Starting Compare on the latest file with no unsaved edits puts the version before its last one on the left, so there is something to see. Both sides open where you were reading (page and position, top line, top-left cell or slide) and stay together when you pick another version for a side; following a citation while comparing brings the left side to the same place. |

### 5.2 Moving to a citation in the document already open

- **Same document and version** (PDF, code, spreadsheet, slides): the view glides to the new
  place (ease-in-out; longer jumps take longer, up to about 0.8 s) instead of snapping. A slim
  **travel rail** at the right edge shows the whole document, a ring where you were and a dot
  sliding to where you're going, labelled (`p 18` → `p 10`, `L20` → `L15`, `A1` → `B4:D12`,
  `slide 2` → `slide 6`); the dot pulses on arrival and the rail fades. A wheel turn or click
  stops the glide. The first jump after a document opens still snaps.
- **Same document, another version** (switching to its other tab, or changing version on the
  strip): the content (not the toolbar or strip) stays hidden for a moment while it lays out, then
  slides in over 0.9 s from the side its version lies on the strip (an earlier version from the
  left, a later one from the right), growing from 93 %. A chip under the toolbar shows both
  versions on a little timeline, earlier on the left, with a dot travelling to the one you moved
  to, which is highlighted (`Jan 12 ●──○ Latest`).
- With the system's reduced-motion setting, places change instantly; the rail and chip still show.

## 6. Settings

### 6.1 Claude

Locus looks for Claude Code (the `claude` command, or `~/.claude`) and Claude Desktop
(`%APPDATA%\Claude`). When one is there and its Locus tools are missing or older than the app's,
Locus asks once per app version ("Use Locus with Claude?"); **Settings → Claude → Set up Claude…**
opens the same dialog any time, with each app's status and a Connect / Update / Install button.

- Both run the MCP server that ships inside Locus, with `Locus.exe` as Node
  (`ELECTRON_RUN_AS_NODE`) and the app's bundled git, so updating Locus updates what Claude uses
  (after restarting Claude Desktop or starting a new Claude Code session).
- **Claude Code**: a plugin installed from the marketplace is updated with `claude plugin
  update`. Otherwise Locus writes a plugin folder to `~/.claude/skills/locus` (plugin.json, the
  skill, and `.mcp.json`); Claude Code loads it as `locus@skills-dir` in its next session.
- **Claude Desktop**: Locus adds a `locus` entry to `mcpServers` in
  `%APPDATA%\Claude\claude_desktop_config.json`, leaving everything else as it was and keeping the
  original as `claude_desktop_config.json.before-locus`; a file that isn't valid JSON is left alone.
- After connecting Claude Desktop while it is running, **Restart Claude Desktop** appears; it
  first says that chats in progress stop (they are saved), then ends Claude Desktop's main process
  (closing its window only hides it in the tray) and opens it again from its Start menu entry.
  Claude Code's own claude.exe is never touched.
- On every start, an installed Locus quietly brings its own Claude setup up to date (a newer
  skill, or Locus moved); it never touches anything it didn't write.
- Uninstalling Locus (not updating it) removes the plugin folder and the Desktop entry.
- Nothing leaves the computer; no config files are edited by hand.

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
- **Tabs:** a tab limit for the editor (notes and flowcharts) and for the viewer, each "No limit"
  (the default) or "At most N". Opening one more tab than the limit closes the tab on that side
  viewed longest ago (a note is saved first); the tab in front is never closed. Lowering the limit
  trims straight away.

## 7. Sharing (later milestone)

Share → sign in with GitHub (device code) → private repo created → invite by username/email →
copy open link. Sync pill: Synced / Changes to share / Updates available. Conflicts on notes
are shown side by side (Keep mine / Keep theirs / Keep both); binary conflicts keep both
copies. Single-file `.locus` package (git bundle) for sharing without accounts.

## 8. Keyboard shortcuts

| Action | Keys |
|---|---|
| Save | Ctrl+S |
| New note | Ctrl+N |
| Open a file | Ctrl+O or Ctrl+P |
| Headings | Ctrl+0 … Ctrl+6 |
| Bold / Italic | Ctrl+B / Ctrl+I |
| Cite what's shown on the right | Ctrl+Shift+L |
| Link to a section of a note | Ctrl+Alt+L |
| Search open document | Ctrl+F |
| Zoom the pane you're in (notes or documents) | Ctrl+= / Ctrl+− or Ctrl+mouse wheel |
| Tour mode | Ctrl+Shift+T |
| Save version | Ctrl+Shift+S |
| Shortcuts | F1 |
