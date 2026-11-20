# UI spec (v1)

Status: draft · Platform: Windows first · Shell: Electron

A desktop app with notes on the left and the source documents on the right. One click puts a
reference to the exact page, lines, cells or area into the note; clicking it later brings you
straight back. It also knows the workspace's version history, so references can point at any
version of a file.

## 1. Window layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◆ Locus  Bracket project  [Save version] [Sync] [Share]                         ☀ ⚙ │ header
├──────────────────────────────────────┬───────────────────────────────────────┤
│ [Review.md ●] [Design.md] Open + ⬡   │ [spec.pdf] [solver.py · Mar 3] Open   │ tabs
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

Logo + name · workspace name (click → open another workspace) · **Save version** ·
sync pill and **Share** (when shared) · light/dark toggle · keyboard shortcuts (F1) · settings ⚙.

### 3.1 Opening files

Each pane has its own **Open**, in its tab row and in its empty state; the side the button is on
is the side the file opens on.

- **Open on the left** (Ctrl+O) lists only notes (`.md`) and flowcharts (`.canvas`), the only
  files the left pane can hold, and opens the one picked there to write and cite in. It always
  shows the latest version, so it has no version selector, history or "Browse this computer…".
- **Open on the right** (Ctrl+P) lists every file and opens it in the viewer. Notes and
  flowcharts picked here show read-only, beside your notes, with an **Edit** button to move them
  to the left. Old versions always open on the right.

The right-hand **Open** has a selector for the version to
show the folder as it was. Its **Version history** button leads to the history: the workspace's
versions, and for the selected one what it changed (added, changed, moved, deleted files).
Clicking a file there opens it as it was in that version; **Browse all files from this version**
and **Back to files** return to the file browser. There is no global "viewing an old
version" mode: each document tab carries its own version (badge on the tab, version strip under
the toolbar), and the file browser's version selector resets to Latest each time it opens.

Folders in both file browsers fold and unfold (click the folder; **Collapse all** / **Expand all**
at the bottom) and show how many of the listed files they hold; the left one shows only folders
that contain notes or flowcharts. Every folder starts folded each time the browser opens.
Searching gives a flat list.

**Welcome screen** (shown when no workspace can be reopened): **Try the demo** first, then open a
folder, create a workspace, open a shared `.locus` file, download from GitHub; and the recent
list. The demo ships inside the app: the first time it is unpacked into `Documents\Locus\Locus
demo` and opens on its **Start here** note; later the same folder is reopened.

**A demo of your own**: **Put a copy in a folder of my own…** under the demo button, and
**Settings → Demo workspace → Create a demo workspace…** once a workspace is open, both ask where
it should go and put a fresh copy there, which opens on **Start here**. The folder picked is used
as it is when it is empty, otherwise a `Locus demo` folder is made inside it (`Locus demo (2)`
and so on when that name is taken), so nothing already there is touched. A folder that holds
files is refused rather than written into.

## 4. Left pane: notes

- Note tabs (● = unsaved), middle-click closes, drag to reorder (both panes), + new note.
- **Right-click a tab**: Save, Rename…, Move to… (new folders are created), Save as… (what is on
  screen goes into a new file and the tab moves to it; the old file keeps what was last saved),
  Save a copy…, Copy link to this note, Export as a web page…, Export as PDF…, Export for
  someone without Locus… (§7), Show in folder, Close, Close others, Delete…. Rename and
  Move rewrite every link to the file. Delete asks first (Cancel is the default), says how many
  links in other notes will be left pointing at nothing, warns about unsaved changes, and sends
  the file to the Recycle Bin. Document tabs on the right offer Copy path, Show in folder, Close,
  Close others and Close all.
- Formatting toolbar: paragraph/heading dropdown, bold, italic, strikethrough, inline code,
  code block, bullet/numbered/task list, quote, table, horizontal rule, link, undo/redo;
  right side: **Tour**. Buttons light up for what applies at the cursor, the dropdown shows the
  current style, and undo/redo grey out when there is nothing to undo or redo.
- Formatting works from the note's structure: italic on bold text keeps the bold; un-bolding part
  of a phrase leaves the rest bold; with the cursor inside formatted text the button removes it;
  each line of a selection is formatted separately, after its bullet; a link's text can be
  formatted without breaking the link.
- Lists change kind in place and keep their indent; the same button again removes the list.
  **Tab** nests a list item and **Shift+Tab** brings it back. A heading inside a quote or list
  keeps the quote or bullet.
- **Pictures**: paste or drop a picture (screenshot, copied image, image file) and it is saved as
  a new file under `/images/<note name>/` and shown at the cursor; nothing existing is replaced.
  When the clipboard also holds text (cells copied from a spreadsheet), the text is pasted. A
  handle at the picture's corner sets its width (drag), or returns it to its own size
  (double-click). The width is kept as `#w=<pixels>` on the picture's address, which other
  markdown tools ignore.
- Editor: a **formatted view** (CodeMirror 6). Markdown renders in place and its markup stays
  hidden while editing; the cursor steps over hidden markup. Markdown shortcuts work as you type.
  A link's label is ordinary text: Backspace and typing inside it edit it, deleting its last
  letter removes the link, and typing at its end writes after the link. Backspace at the start
  of a heading, bullet, number, task or quote removes that formatting. **Edit target** in a link's hover
  card shows that link's markdown until the cursor leaves it.
- Editing never breaks formatting (`scripts/test-editing.mjs` tries every cursor place and
  selection in a set of sample notes):
  - Typing, pasting, cutting or deleting a word over a selection takes text away the way
    Backspace does: markup only partly selected stays, and formatting whose text is all selected
    goes with it.
  - Enter at the start of bold (italic, code, a link) breaks the line before it, at its end after
    it, and in the middle closes it on the first line and opens it again on the next.
  - Spaces typed or left at the inside edge of bold, italic or strikethrough move just outside
    it. Two pieces of the same formatting that come to touch become one. Bold or italic written
    with `_` becomes `*` when edited, since `_` stops working inside a word.
  - The cursor never stands before a line's hidden bullet, checkbox, heading or quote marks.
    Joining two lines drops the second line's marks. A numbered list whose first item stops
    being one is numbered again from 1.
  - A bracket typed into a link's label is saved as `\[` or `\]`, and backslash escapes show
    as the character alone.
- Tables are always shown as tables, including straight after **Table** inserts one. Clicking a
  cell edits it in place (same formatted view). The cell keeps its size while edited and its text
  wraps inside it, so the table never grows past the note. Tab / Shift+Tab and Enter move between cells,
  Tab from the last cell adds a row, Esc finishes. While a cell is edited, buttons under the
  table insert a row above or below, a column left or right, align the column (left, centre,
  right; the same button again clears it), or delete the row, column or table.
- The file on disk is the source of truth: only edited lines change; line endings and
  encoding are preserved. Autosave after a pause, with a small "Saved" toast.
- **Changed outside Locus.** A note or flowchart without unsaved changes shows a change made to
  its file elsewhere (Claude, another editor, a sync) as soon as it is seen. One with unsaved
  changes is never written over. Before every save Locus checks that the file still holds what it
  last read or wrote; when it doesn't (or the watch sees it change), saving that tab pauses, its
  tab shows a red **!**, and a bar above it says it was changed outside Locus while there were
  unsaved changes, and why saving is paused:
  - **Merge** (notes only, offered when the two sets of changes touch different lines,
    next-door lines included) keeps both and saves. Changes to the same lines, or additions at the
    same spot, can't be merged and the bar says so.
  - **Keep mine** saves what is on screen over the file.
  - **Use the file's** shows the file and drops the unsaved changes; Ctrl+Z brings them back.
  - **Show the file's** opens the file as it is now in the viewer, to compare.
  Each choice reads the file again first, so a later outside write is included. Typing until the
  note matches the file settles it without asking. While the bar is up, Ctrl+S says why it isn't
  saving, the tab can't be closed (it says why), the tab limit closes other tabs instead, and
  opening another workspace or restarting for an update waits until the user has chosen. A change
  Locus wrote itself only counts as its own while the file still holds exactly what it wrote, so
  an outside write straight after an autosave is still seen.
- Windows and Unix line endings both count as line breaks, whichever way a file mixes them — a
  checkout that converted them, a script that appended a line, another editor. The file is
  written back with the ending it mostly used, so a Windows file stays a Windows file and a
  stray ending never turns a note into one long line.

### 4.1 References in the note

- Accent colour, medium weight, no underline until hover, small icon by type (PDF page, code,
  grid for cells, # for notes, play for media).
- Nothing is written beside a link: no version or "changed" badges, in notes or in flowchart
  boxes. Whether a link is pinned, and what has happened to what it cites, is in its hover card;
  Save version asks about changes (§4.5).
- Broken references: red wavy underline with the reason; `moved` ones offer **Fix links**. A
  link to a note that was renamed or moved outside the app is not broken: it finds the note by
  its identity, and **Fix links** writes the new path.
- Renaming or moving a file from the file browser updates the links to it and saves that move as
  an automatic version of its own, so the file can still be read under its old name in every
  version that had it, however much it is rewritten afterwards.
- A link whose file has left the workspace while the version it cites can still be read is not
  broken either: it opens that version, and is drawn in grey with a dotted underline that says
  so when hovered. Red is kept for a link with nothing behind it at all.
- **Hover card** (~400ms): preview (page thumbnail with the area drawn, code lines with
  numbers, mini table of cells) · file name and folder · location description · kind
  ("Live · cited from the version of Mar 3 · follows the file when you save a version" or
  "Pinned · always shows the version from Mar 3") · what changed, if anything · quote in italics
  · buttons **Open**, **Compare with latest** and **Make live** (pinned), **Update link to
  latest** and **Compare with cited version** (live, changed), **Pin to this version** / **Pin
  to cited version** (live), **Redraw area** (a box on a PDF page), **Rename**, **Edit** (the citation
  editor, §4.4), **Remove link**.
- Click → opens the document on the right at the location, highlighted, and always placed the
  same way: the cited area, lines, cells or slide centred in the view (one taller than the view
  starts at its top; a page alone shows the top of the page), as far as the document can scroll.
  If the view is already there (a short file, or the place already on screen), nothing travels:
  the cited highlight pulses once. A
  live link whose content changed opens the latest version with a notice saying so, with
  **Compare** and **Show the cited version**; a quoted PDF passage that moved is found on its
  new page.
- A file that was moved or renamed is read in older versions under the name it had then: links
  carry the name a file goes by now, so every version of it, the comparison and the check in §4.6
  follow the rename back. A move on its own is not an edit, and is never reported as one. Where
  the move has not been saved as a version yet, the file is matched by its contents instead.

### 4.2 Citing

- **Cite** button at the far right of the viewer toolbar (gold), label depends on the view:
  Cite page / Cite area / Cite lines / Cite range / Cite time. Shortcut **Ctrl+Shift+L**.
- **Area** in the PDF and slide toolbars draws a box: drag over the page or the slide, and the
  Cite button becomes **Cite area**. A box quotes the words inside it (the selected text wins if
  there is a selection), so the link can find that place again after the file changes — see §4.6.
  A box over something with no words in it has nothing to quote, and is asked about instead.
- Inserts the reference at the cursor (see link-format §3 for the label rules) and opens an
  inline rename box over the label: label pre-selected, 2px accent border, hint
  "Enter to name · Esc keeps '<default>'". Typing replaces, Enter confirms.
- Not yet: dragging a selection from the viewer into the note.

### 4.4 The citation editor

**Edit** on a hover card opens a dialog that changes a link without ever showing markdown:

- **Points at**: the whole file, a page, an area on a page, lines, a slide, cells, a section or a
  time; only what the file can hold is offered.
- **Document**: a chip with the file name and folder, and **Change…**, which opens the file
  browser showing only files that can hold the chosen kind of place.
- **Version**: Latest, or any saved version of that file. Choosing an older version pins the
  link; with Latest it keeps the kind it had (live stays live, pinned stays pinned to the newest
  version).
- **Place**: the page, first and last line, slide, range or section, or a time. **Pick in the
  document** steps the dialog aside, opens the document on the right and waits: draw an area,
  select cells or lines, or go to the page, slide or time, then **Use this place**.
- **Lands on**: a preview of what the reader will see, the same one the hover card shows.
- A place typed by hand drops the link's quote, because the quote described the old place; a
  place picked in the document takes the quote from what was selected there. The label is never
  changed by the editor (**Rename** does that).
- **Save** writes the link back into the note; **Cancel** leaves it as it was.

### 4.5 Link to a section

The bookmark button on the toolbar, or **Ctrl+Alt+L**. It lists the headings of **this note as it
is on screen** (headings typed but not saved included), or of any other note picked from the
drop-down. Typing filters the list; ↑ ↓ move and Enter (or a click) inserts the link at the
cursor and opens the rename box. A heading of the same note becomes a plain `#heading` link,
which can never break; a heading of another note records that note's identity (link-format §2.5).

### 4.6 Keeping links up to date

The right pane shows files as they are now: the workspace is watched, so a file another program
saves appears within a moment, without clicking into the window. Writes Locus makes itself are
passed over, since the part of the app that made them has already shown them. (A window coming
back to the front still re-checks, for folders that cannot be watched.) A
live link records the version it was cited from and is brought forward each time a version is
saved, so it never drifts far from the file.

**After Save version** (and when Save version finds nothing new to save but links are waiting),
Locus checks every live link whose file changed since it was cited. It asks which files have
changed once per version the links were cited from, so a workspace of hundreds of links where one
file was edited answers in about a second:

| File | Follows by itself when | Needs a look when |
|---|---|---|
| Code, text | the cited lines are untouched or only moved | lines in the range were edited or deleted (the same lines in the new version are proposed) |
| PDF with a quote | the quote is found again, on this page or another | the quote was reworded or removed (an area then falls back to its picture, below) |
| PDF area, no quote (a figure, a photo, a scan) | the picture inside the area is the same, in the same place | the picture moved, was resized or is repeated (the place it was found is proposed), or wasn't found (the same area is proposed) |
| PDF page, no quote | never (nothing to check) | always; the same page is proposed |
| Spreadsheet | a named range still resolves; the cited cells hold the same values | a value in the cited cells changed |
| Slide with a quote | the words are found again, on this slide or another | the words were reworded or removed |
| Slide or slide box, no quote | never (nothing to check) | any change to the deck |
| Pictures, recordings | never | any change to the file |
| Any file, whole-file link | always | never |
| Any file | it was only moved or renamed | it was moved and edited |

A link whose file was deleted stays on the version it was cited from (it becomes pinned). Links
to notes are left alone: a note is always read as it is now.

- **Finding a picture again**: a box over a figure has no words to quote, so Locus renders the
  box from the cited version and looks for it in the new one, pixel against pixel (normalised
  correlation in grey, so recompression and antialiasing don't matter): the cited page first, then
  outward, up to 60 pages or six seconds a box; when nothing matches at the old size it tries sizes
  from 0.7 to 1.4 times on the pages that came closest. Only the same picture in the same place
  follows by itself. A picture found elsewhere is a proposal, worded by how sure it is ("the same
  picture is now on page 2", or "the best match … (87% alike)"); one found about equally well in
  several places (a logo in every header) is called repeated and the one nearest the old place is
  proposed. A blank area (white paper, a flat fill) has nothing to look for and says so. Not built:
  matching a picture by the identity of its embedded image, which would be exact even when resized,
  and boxes on slides, which still ask on any change to the deck.
- **Nothing to decide, nothing to answer**: when every link the check found can follow its file
  by itself, Locus updates them there and then and says so in a notice with **Undo**. The summary
  only appears when something needs a person: a link that cites something that changed, or one
  whose file was deleted.
- **The summary** is a bar under the header, not a dialog: it says how many links can follow by
  themselves, how many cite something that changed, and how many point at deleted files, and
  offers **Update the N and review the rest**, **Go through them one by one**, or **Not now**.
  Nothing is taken over while it waits, so typing carries on. After **Not now**, pressing Save
  version again brings the summary back.
- **Reviewing a link**: a bar under the header names the link and what happened. The note opens
  at the link on the left; on the right the cited version and the latest version sit side by
  side, each marked: what was cited on the left, the proposed place on the right (code shows as a
  difference view). The viewers' Cite buttons are hidden while reviewing: their Live/Pinned tag is
  about the next link you would insert, and beside a link under review it read as a description
  of that link. **Update the link**
  takes the proposal (for code, the two line boxes can be changed first). **Use what's selected
  on the right** takes the place selected in the latest version instead: an area drawn on a PDF
  page, the cells picked, the page or slide shown; the old quote is dropped, because it no longer
  applies. **Keep the old version** pins the link so it never asks again. **Skip** leaves it for
  next time. **Stop reviewing** ends the round and keeps what was decided so far.
- **Writing back**: the links are rewritten with the new version and place and saved as one
  automatic version, "Automatic version (updated N links)". A label that names the old place
  ("p12", "slide 4", "B4:D12", "L20-33") is renumbered; nothing else in it is touched. A notice
  offers **Undo**, which puts back the notes that were rewritten unless they changed since.
- **Update link to latest** on a hover card does the same for one link; **Redraw area** opens
  the review for a PDF box so a new one can be drawn.
- **Record**: a note with links that have no saved version (made by hand, or by an older app), or
  links to notes that could stop working if the note is renamed or moved, shows a notice once per
  session. **Record** saves the latest version in each link of the first kind, and gives the note
  a hidden id (in the note and in the link) for the second. Pictures, outside files and links to a
  heading of the note they are written in are left alone.

### 4.6.1 What a notice says

Every notice says what happened in its first line and, under it in smaller text, what it means
and what its button will do — never jargon, never a bare warning with nothing to act on, and
never a promise it cannot keep (Record's help says Ctrl+Z undoes the change in the note, which it
does; it does not say the whole thing can be undone, because the id it gives the other note stays).

A notice about particular links also **names them and marks them**. Under the text, "Marked in the
note:" is followed by a chip for each link (up to six, then "and N more"); clicking one scrolls to
that link and flashes it. The links themselves are drawn with a dotted amber outline, unlike the red
wavy line of a broken link, for as long as the notice is up, and the marks go with it. A screen of
text between two links does not matter: the chip takes you there. Following one of the marked links
to see what it is leaves the notice where it is.

A link to a heading of the note it is written in, written with the note's own path, is no reason for
a notice and is not touched by Record: it resolves and loses nothing, and a notice should be about
one thing. The demo workspace ships with nothing for these notices to report; a copy made by an
older version still has its old links, and Record fixes them.

### 4.7 Tour mode

Steps through the note's references in order with ←/→ (or PageUp/PageDown); the viewer
follows and the current reference is highlighted in the note. Esc exits. Each stop puts its link
in the middle of the note and keeps it there while pictures above it finish loading (until the
reader scrolls). A stop that links to another note, a flowchart or a section of the same note
opens it on the right, read-only, so the note being toured stays at the link and the tour goes
on. Switching to another note on the left ends the tour.

### 4.8 Flowcharts

The left pane also opens flowcharts: `.canvas` files in the open JSON Canvas format (the one
Obsidian's Canvas uses), so they open in Obsidian too. Locus adds fields Obsidian ignores: box
`shape`, and for arrows `route`, `style` and bend `points`. Files are written one box or arrow
per line, so diffs stay readable.

- **New flowchart** (flowchart icon in the tab row, or the empty pane). The left-hand
  **Open** lists flowcharts with notes; links to a `.canvas` file open it on the left.
- **Boxes**: process, decision, start/end, input/output, sub-process, note. Add from the
  toolbar (the new box's text is selected, so typing replaces it); change the shape of a selected
  box from the toolbar; drag to move (snaps to an 8 px grid), drag the corners to resize.
- **Box text** is markdown with citations, edited in place with the notes editor (double-click or
  Enter; Esc or clicking away finishes). Citations show as in notes; clicking one opens what it
  cites.
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

### 4.9 Embedded views

Instead of a link, a note can show what it cites: a picture of a PDF page, a slide, or a box drawn
on either, or a table of spreadsheet cells. The syntax is a `!` reference (link format §2.7).

- **Inserting.** Next to **Cite** on the right: **Insert picture** for a PDF or slide deck (the
  box drawn with Area, else the page or slide), **Insert table** for a spreadsheet (the selected
  cells). Shortcut **Ctrl+Shift+E**. The view goes in its own paragraph below the cursor, with the
  usual rename box. Files that can't be shown (code, notes, media, flowcharts) get a link and a
  toast saying why. A link already in the note can become a view from its hover card (**Show as
  picture** / **Show as table**), and back (**Show as link**).
- **What it shows.** Live views show the latest file and are drawn again when it changes on disk;
  the old picture stays until the new one is ready. Pinned views show their version only. Under
  the view: the file icon, its name, a **Live** / **Pinned** / **Outside** chip, **Changed** when
  what it cites changed since it was cited, and a line when a live view's file is gone and the cited
  version is shown instead.
- **Tables are read-only**: the cells' values, number formats and merges, fixed column widths.
  Nothing in them can be edited or selected for editing.
- **Using it.** Clicking the view opens the file on the right at the place. Hovering shows tools on
  the caption line (never over the view): **Open**, **Change area** / **Change cells** (opens the
  file with the current box or cells shown, and a notice with **Use this box** / **Use these
  cells** and Cancel), **Show as link**, and **…** for the full hover card (pin, make live, compare,
  rename, edit, remove). A name Locus suggested follows a new area or cells; a name the user typed
  stays.
- **Size.** Drag the bottom-right corner to resize (it writes `w=`); double-click it for the natural
  size. Views never make the note wider than its pane.
- **When it can't be drawn**, the view says why in red with a help line (page or slide past the
  end, box outside the page, sheet or range gone, pinned version missing, file missing, file
  unreadable). A file caught half-saved keeps the last picture.
- In a flowchart box or a note table cell, which are too small for it, a view shows as a link to
  what it cites.
- Backspace or Delete next to a view removes it whole; Ctrl+Z puts it back. A read-only note shows
  views without the tools that change it.

## 5. Right pane: documents

- Document tabs show a version badge when not on the latest version. Files come from this
  pane's **Open**; external files are allowed and marked.
- Empty state: "No document open", pointing to **Open**.
- Notes and flowcharts opened with this pane's **Open** show read-only here: links, hover cards and
  **Cite lines** / **Cite flowchart** work, nothing can be edited, and **Edit** opens them on
  the left.
- Every tab keeps its own scroll, zoom, search and version.
- **Version strip** under the toolbar: one dot per version of this file, current one
  highlighted, gold dots for versions cited by the open note. Click a dot to view that version.
- **Restore this version** appears on the strip while a past version is the one on screen. It
  asks first, then writes that version over the working file and returns the tab to Latest, so
  what was restored is an ordinary unsaved change: look at it, save a version to keep it, or take
  the **Undo** in the notice. A file that had been deleted comes back this way; one renamed since
  is read under the name it had then.
- **"Cited in" markers**: gold bookmarks in the page margin / gutter where any note in the
  workspace cites this document; hover lists the notes.

### 5.1 Viewers

| Viewer | Behaviour |
|---|---|
| PDF | Grey background, white pages, page box (printed labels supported), zoom, search, **Area** tool (crosshair, drag a translucent gold box; Esc cancels), text selection becomes the quote |
| Code / text | Read-only, syntax highlighted, line numbers; cited lines get a pale gold band |
| Spreadsheet | Excel-like grid: column letters / row numbers, column widths, merged cells, fills, bold, number formats, sheet tabs at the bottom; name box + formula bar; virtualised rendering. Pictures anchored in a sheet are drawn over the cells they are pinned to, scrolling and scaling with them, and never take a click meant for a cell |
| Slides | Every slide in a scrolling list, slide box, **Area** tool (a box on a slide, cited as a place within it). Equations and other parts PowerPoint wrote twice are drawn from the picture it keeps for readers that cannot show the modern form; where there is no picture, the equation's characters are shown as text |
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
- With Motion set to Reduced (or Match Windows, when Windows asks for less motion), places change
  instantly; the rail and chip still show.

## 6. Settings

Terminology, theme and colours, autosave, motion, tab limits, **Demo workspace** (a fresh copy of
the demo wherever you choose, see §3), Claude and **Updates** (§6.2).

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
  A marketplace plugin updates itself as soon as a release is published, so it can be newer than
  the app; that counts as connected (versions are compared as numbers, not for equality), no
  Update is offered, and the row says why.
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

### 6.2 Updates

An installed Locus looks on GitHub (`DanKrsi/locus` releases) for a newer version each time it
starts, and downloads it in the background without asking.

- Once it is downloaded a banner says "Locus *X* is ready to install (you have *Y*)", with the help
  line saying it came from GitHub and what each choice does. **Restart now** saves open notes,
  installs it and opens Locus again; **Later** (or ×) hides the banner, and the update installs by
  itself the next time Locus closes. Settings and sign-in are kept.
- **Settings → Updates** shows the version, what the last check found (up to date, downloading with
  a percentage, ready, or why it could not check), and **Check for updates** (or **Restart now**
  once one is ready).
- A failed check (no internet, GitHub down) only shows there; it never interrupts.
- Only full releases count, not pre-releases. A copy run from source never updates itself.
- Each release carries `latest.yml` and the installer's `.blockmap`, which is what installed copies
  read; the release workflow refuses to publish without them.
- Copies older than 0.6.19 have no updater, so moving to 0.6.19 is a manual install once.

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

- Theme and light/dark, autosave.
- **Motion**: Match Windows (the default), Full or Reduced. Reduced moves straight to a link's
  place: no glide, no slide between versions, no pulse.
- **Tabs:** a tab limit for the editor (notes and flowcharts) and for the viewer, each "No limit"
  or "At most N". A new installation starts at 12 notes and 8 documents, because an open document
  stays loaded; "No limit" is still a choice. Opening one more tab than the limit closes the tab on that side
  viewed longest ago (a note is saved first); the tab in front is never closed. Lowering the limit
  trims straight away.

### 6.3 Claude panel

**Claude** in the header opens a panel at the right of the window where the user works with their
own Claude Code, in the workspace folder. It is the Claude Code they installed and signed in to
themselves; Locus never handles a Claude login, key or subscription. The panel has two tabs,
**Chat** (the default) and **Terminal**; the tab chosen is remembered.

#### Chat

A conversation with Claude about what is open, like the Claude add-ins in other apps. Claude sees
the note and the document beside it, opens places, and changes notes in the editor, asking first.

- **What runs.** On the first message, main starts Claude Code in the background:
  `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-prompt-tool stdio --permission-mode default
  --mcp-config <file> --allowedTools <the look tools> --append-system-prompt <how to work in
  Locus>`. The user's own settings, plugins and sign-in apply; `--permission-mode default` means
  Locus asks before changes even when the user runs Claude Code in another mode elsewhere. The
  config gives the live tools, plus the Locus tools (the bundled server, §6.1) when Claude Code
  doesn't have them yet. Main owns the conversation: hiding the panel, switching to the terminal
  or reloading the window loses nothing. Starting takes a few seconds; the message shows at once,
  with "Working…".
- **The conversation.** The user's messages, Claude's replies streaming in (a little markdown:
  paragraphs, lists, tables, code, bold; Locus links as buttons that open their place, web links
  open in the browser), and one line for each thing Claude does, in plain words ("Looked at what
  you have open", "Read notes/plan.md", "Changed notes/plan.md"); clicking a line shows what came
  back. Claude's housekeeping (finding its tools) is not shown. Nothing Claude writes is drawn as
  HTML: text from files in a shared workspace can't add elements to the page.
- **Asking first.** Tools that only look or open a place run without asking: `current_view`,
  `read_note`, `screenshot`, `show`. Everything else Claude Code would ask about (changing a note,
  citing, saving a version, writing a file, running a command, the web) comes as a card, **Allow
  Claude to change notes/plan.md?**, showing the change itself (old text struck through, new text
  highlighted; the command; the file and its text), with **Allow**, **Allow for this chat** (that
  kind of tool goes ahead without asking until a new chat) and **Deny** (Claude is told no). Stop,
  a new chat or the session ending answers waiting cards with no.
- **A note open in Locus is never written behind the editor.** A file write to it (Write, Edit, the
  Locus write_note) is refused on the spot, telling Claude to use `edit_note`, so the change
  happens in the editor where the user sees it. (Claude Code's own allow rules, if the user set
  any, are theirs; a write they let through is still caught by the "Changed outside Locus" bar of
  §4.)
- **Changes in the editor.** `edit_note` and `insert_text` change the note on screen, never the
  file behind it: the change is one undo step of its own (never merged with the user's typing),
  the user's cursor stays where it was, unsaved typing is kept, and the changed text is
  highlighted. Its line in the chat has **Show** (scroll to it and highlight it again) and
  **Undo** (take back just that change, even after typing elsewhere in the note; if its text was
  since edited or undone, it says so and leaves it, Ctrl+Z being the way). An edit whose text
  isn't in the note exactly once changes nothing and says why, so Claude reads the note again.
- **Stop** (or Esc in the message box) interrupts Claude; the conversation goes on. **+** in the
  header starts a new chat (ending the session).
- **Composer.** Enter sends, Shift+Enter is a new line. What is picked out in the pane last worked
  in shows as a chip above it ("BDS-100 p5 · in view"); **Add** puts its reference link into the
  message. An empty chat offers three starters (What am I looking at? / Cite my selection / Check
  my note). The model Claude Code is using shows in small type.
- **Problems.** Not signed in: a card says Claude Code needs signing in, that Locus never handles
  the sign-in, to type `/login` in the terminal and send the message again, with **Open the
  terminal**. Claude Code stopping (it crashed or couldn't start): what it printed, and **Open the
  terminal**; the next message starts it again, resuming the same conversation (`--resume`). Not
  installed: how to install it and sign in.

#### Live tools

`locus-live`, an MCP server inside Locus given only to the panel's Claude (chat and terminal):

| Tool | Asks | What it does |
| --- | --- | --- |
| `current_view` | no | The workspace, the note being edited (path, cursor line, selection with its text and link), the document on the right (path, kind, version, what is selected or in view as a link with its quote, what it is compared with; `loading` while it opens), the open notes and documents. |
| `read_note` | no | A note as it is on screen, unsaved typing included, lines numbered (`12| text`), up to 2000 lines at a time; notes not open are read from disk. |
| `screenshot` | no | A picture of the window, or of the notes or document pane (JPEG, at most 1600 px wide). |
| `show` | no | Opens a Locus link or destination as clicking it would (a note at lines opens with them flashed) and says what it opened, or that nothing is there. |
| `edit_note` | yes | Exact replacements (each old text must appear once) in a note, in the editor. Opens the note. Not flowcharts or past versions. |
| `insert_text` | yes | Adds markdown at the cursor, start, end, after a line, or at the end of a section; can create the note. |
| `cite_selection` | yes | Cites what is selected or in view in the document viewer through Locus's own Cite (the version recorded as Cite records it; Locus's label unless one is given), as a link or, with `embed`, an embedded view (§4.9). |
| `save_version` | yes | Saves the open notes and records a version, as Save version does (then the link check). |

Their results end with "(Locus change cN)" for changes, which the chat turns into Show and Undo.
The live server listens on 127.0.0.1 at a random port, and answers only requests that carry this
run's random token, have no Origin header (no web page) and are addressed to `127.0.0.1:port` (no
DNS rebinding). Its config files are written to Locus's own settings folder, never the workspace.

#### Terminal

Claude Code as it runs on its own, in a real terminal, started the first time the tab shows, with
`--mcp-config` (the live tools) and `--append-system-prompt`. Nothing is pre-approved: Claude Code
asks about trusting the folder and about each tool as it always does. The header's terminal/Claude
button swaps to a plain PowerShell in the same folder and back, and ⟳ starts again. Main chooses
the program; the page only asks for "claude" or "shell".

- **Selection chips.** Above the terminal, what is picked out in the pane last worked in shows as a
  chip ("Selected in the note: design-basis.md line 3", "In view in the document: BDS-100 p5"):
  selected text in a note (as a link to its lines, quoting the text), or a document's selection,
  area, cells or page in view (as Cite would link it). **Add to prompt** pastes the reference link
  into what is being typed to Claude. Making the chip records nothing: no version is saved and no
  note id is added, so a link to the latest version stays a link to the file as it is.
- **Keys.** Keys typed in the panel are the terminal's: Locus shortcuts (Ctrl+O, Ctrl+N, tour keys)
  don't fire there. Ctrl+C copies when terminal text is selected and otherwise interrupts; Ctrl+V
  pastes.
- **No Claude Code.** The terminal says it isn't installed, how to install it and sign in, and
  offers **Try again** and **Open a plain terminal**. If Claude Code is installed without the
  Locus tools, a note says what Set up adds and has **Set up** (the Claude dialog, §6.1).
- **Edits.** In the terminal Claude may edit files directly. A note open without unsaved changes
  reloads as soon as it is written, so the user sees the edit. A note with unsaved changes is never
  written over: the bar described in §4 ("Changed outside Locus") asks what to keep.

#### Both

- **Lifecycle.** One chat session and one terminal session at a time. Hiding the panel keeps them
  running; they end when another workspace opens, the window closes, Locus quits or installs an
  update. Ending a session ends only the processes Locus started.
- The panel's width is dragged at its left edge and remembered, as is whether it is open.

## 7. Export

Right-click a note's tab. An export is of **what is on screen**, unsaved changes included, and
never changes the note.

### 7.1 As a web page or a PDF

One file: the note formatted as it looks in the app, with its pictures and embedded views
(§4.9) inside it, and its links still working. A view that can't be drawn goes out as a link. A link opens the file it cites on this computer: a PDF at its page, a note at its
heading, anything else at the file. A section link stays inside the page. The recorded version
isn't part of the link, so what opens is the file as it is now. The PDF is printed by Locus
itself, with no print dialog (Letter paper, 0.7 inch margins).

### 7.2 For someone without Locus

A folder they can open with no install and no server. The dialog first asks **what the folder
should also carry as plain files**: *only the files this note links to* (one folder, one pile) or
*the whole workspace* (folders kept, as a code tour needs). It then says exactly what goes in:
how many notes, how many files, how many of those an older version, how many from outside the
workspace, and any link whose file can't be found; and roughly how big it will be. Nothing is
written until a folder is chosen.

**What the folder holds**, named `<note> (Locus)`:

- **`START HERE - <note>.html`**, the one thing to double-click.
- **`Locus viewer/`**: the viewer (about 6 MB) and every cited file as a script the page loads.
  A page opened from a disk cannot read its neighbours, so each file travels as a script instead.
- **Plain copies** in their original formats: `Original files/` (one pile, with an older version
  named like `client (version Mar 3, 2026).py`), or the workspace with its folders kept plus an
  `Outside the workspace/` folder. Notes and flowcharts are left out of the plain copies.

**What the viewer does**: the note on the left, formatted as in Locus, with the notes it links to
in their own tabs; clicking a link opens what it cites on the right in the app's own viewers, at
the exact place (PDF page and area, code lines, spreadsheet range, slide, picture, a time in a
recording). Tabs carry a date badge for a cited older version. Nothing can be edited, cited or
compared, and there is no version strip. A file the viewer can't draw (a flowchart, a Word
document) offers **Save a copy**. A link whose file was left out says so instead of opening.

**Limits**: at most 400 notes and 1.5 GB per export. Only the versions links cite are included,
not the whole history. The viewer is tested in Chrome and Edge.

## 8. Sharing (later milestone)

Share → sign in with GitHub (device code) → private repo created → invite by username/email →
copy open link. Sync pill: Synced / Changes to share / Updates available. Conflicts on notes
are shown side by side (Keep mine / Keep theirs / Keep both); binary conflicts keep both
copies. Single-file `.locus` package (git bundle) for sharing without accounts.

## 9. Keyboard shortcuts

| Action | Keys |
|---|---|
| Save | Ctrl+S |
| New note | Ctrl+N |
| Open a note or flowchart (left) | Ctrl+O |
| Open any file in the viewer (right) | Ctrl+P |
| Headings | Ctrl+0 … Ctrl+6 |
| Bold / Italic / Strikethrough / Inline code | Ctrl+B / Ctrl+I / Alt+Shift+5 / Ctrl+E |
| Web link | Ctrl+K |
| Code block / Quote | Ctrl+Shift+K / Ctrl+Shift+Q |
| Bulleted / Numbered / Task list | Ctrl+Shift+] / Ctrl+Shift+[ / Ctrl+Shift+X |
| Table | Ctrl+T |
| Nest / un-nest a list item | Tab / Shift+Tab |
| Cite what's shown on the right | Ctrl+Shift+L |
| Insert a picture or table of what's shown on the right | Ctrl+Shift+E |
| Link to a section of a note | Ctrl+Alt+L |
| Search open document | Ctrl+F |
| Zoom the pane you're in (notes or documents) | Ctrl+= / Ctrl+− or Ctrl+mouse wheel |
| Tour mode | Ctrl+Shift+T |
| Save version | Ctrl+Shift+S |
| Keyboard shortcuts | F1 |
