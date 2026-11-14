# Master plan: catching up with Folio and going past it

Drafted 13 November 2026 from the Folio 0.3.0 overview, checked against Locus 0.2.12 (spec and
code). Status: **phases 1 to 4 built (0.3.0 to 0.6.0)**; phase 5 is a list to pick from.

## 1. Where Locus stands

### Already level with Folio

Two panes, themes, zoom, Simple/Git wording, tab limits, the formatted editor, tables, inline
pictures, citing with the rename box, live and pinned links, hover cards, glide and travel rail,
version slide-in, version strip, compare, "Cited in" markers, tour mode, flowcharts, version
history, moved-file detection, `.locus` packages, GitHub sharing and sync, the nine Claude tools
and one-click Claude setup, the per-user installer.

### Already ahead of Folio

- One **Open** with Edit or View (Folio has two browsers with different rules).
- Links land centred every time, and pulse instead of replaying the trip when already there.
- An area tool for pictures (Folio cites only the whole image).
- Updating keeps your settings and sign-in (Folio's installer wipes them).
- Releases build and publish themselves from a tag (Folio's are made by hand).

### Behind Folio

| # | Area | What Folio has that Locus lacks |
|---|---|---|
| 1 | Link upkeep on Save version | Checks every live link, moves the ones that only shifted, asks about the ones that changed (side-by-side helper), renumbers labels like "p12", one Undo |
| 2 | Note identity | A hidden permanent ID so links to a note survive renames outside the app; the "Record" banner for old links |
| 3 | Citation editor | A dialog with preview and "Pick in the document"; **Redraw area** for PDF boxes. Locus shows raw markdown |
| 4 | Export | Note as PDF or web page with working links; a folder for someone without the app, with a browser viewer |
| 5 | Tab right-click menu | Save, Rename, Move, Save as, Save a copy, Copy link, Show in folder, Close others, Delete to Recycle Bin (with a count of links left dangling) |
| 6 | Pictures | Paste or drop to insert; drag a corner to resize |
| 7 | Editor polish | Toolbar buttons that light up; formatting that respects structure; Tab to nest lists; shortcuts for every toolbar button; column alignment in tables |
| 8 | Small things | Motion setting; a notice bar for messages with buttons; file browser with Collapse/Expand all, counts and type badges; strip marks for edited, moved and "not saved"; Windows-1252 notes kept as they are; code labels without line numbers; PDF Fit page; copy cells from a spreadsheet; equations on slides |

Also to check in Locus, because Folio found it in the same code lineage: the Claude plugin
carries its own version number (0.2.1 while the app is 0.2.12), so people already connected may
not receive tool changes.

## 2. Decisions needed before phase 2

**A. What the right pane shows.**

- *Folio:* saved versions only. A link always opens exactly what was cited, but a file edited in
  Excel doesn't show until a version is saved. Folio's overview calls this its main cost.
- *Locus today:* the file as it is now. Friendlier, but a live link points at a moving target.
- *Recommended, a hybrid:* keep showing the file as it is now, clearly marked "not saved in a
  version yet", and add Folio's check on Save version. Links then get moved forward and reviewed
  at each save, so they never drift far, and outside edits still show at once.

**B. Badges beside links.** Folio's notes show none; the save-time check does that job.
Recommended: remove Locus's date and "changed" badges once phase 2 is in, and keep the state in
the hover card.

## 3. The phases

Each phase ends in a release. Sizes are relative: S is days, M about a week, L more.

### Phase 1: everyday smoothness (M) — done in 0.3.0

Things felt in the first five minutes. None depends on the decisions above.

- [x] Tab right-click menu (row 5), and tabs drag to reorder.
- [x] Paste, drop and resize pictures (row 6).
- [x] Editor polish (row 7).
- [x] Motion setting. (The notice bar already existed.)
- [x] File browser: folders fold, with counts.
- [x] **Try the demo** button on the welcome screen, so a new user needs no download.
- [x] One version number for the app, the plugin and the tool server.
- [x] Spec tidied: drag-to-cite, Link to a section and the F1 shortcuts list were described but
  never built.

Moved to later phases: marks on the version strip for edited, moved and "not saved" (phase 2,
with link upkeep); **Link to a section** and the F1 shortcuts list (phase 3, with the citation
editor); Windows-1252 notes, PDF Fit page, copying cells, equations on slides (phase 5).

### Phase 2: links that look after themselves (L) — done in 0.4.0

Decisions taken: the right pane keeps showing files as they are now (the hybrid), and badges
beside links are gone.

- [x] Note identity, and the Record notice.
- [x] The check after Save version: summary, auto-update, Undo.
- [x] Reviewing a changed link side by side; **Use what's selected on the right** (which is
  also how an area is redrawn); **Update link to latest** and **Redraw area** on hover cards.
- [x] Label renumbering; code labels without line numbers.
- [x] Badges removed.

Not done, moved to phase 5: slide links follow only when the file is unchanged (Folio follows a
slide that moved within the deck); a block of spreadsheet cells that moved elsewhere is not
found; marks on the version strip for edited, moved and "not saved"; the review of links inside
flowcharts uses the same bar but the flowchart doesn't flash the box.

### Phase 3: edit a link without seeing markdown (M) — done in 0.5.0

- [x] The citation editor, opened by **Edit** on a hover card: what it points at, which document
  and version, where inside it, and a preview. **Pick in the document** steps aside so the place
  can be chosen in the viewer.
- [x] **Link to a section** (Ctrl+Alt+L), of this note as it is on screen or of any other note.
- [x] The keyboard shortcuts list (F1, and a button in the header).

**Edit target** (the raw markdown of one link) is still there as a fallback for links the editor
can't describe, such as a web link.

### Phase 4: share with anyone (L) — done in 0.6.0

- [x] Export a note as a web page or a PDF: the note as it looks, pictures inside the file, links
  that open the cited documents on this computer.
- [x] Export a folder for someone without Locus: the note, the files it cites and a viewer built
  from the app's own viewers, running from a disk with no install and no server.

Not done, and not in Folio either: hover cards in the viewer; flowcharts in the viewer (they are
carried as plain copies, as Folio does). The viewer always carries the files the note links to;
the choice in the dialog is only about the plain copies beside them.

### Phase 5: past Folio (pick and order as wanted)

Everything here is on Folio's own "not built" list, or absent from it:

- **Restore** an old version of a file (Folio can only view and copy by hand).
- Files changed in another program refresh at once (Folio waits for the window to regain focus).
- A review **before** saving a version, not only after.
- Flowcharts: hover cards, tour mode, the update helper, copy and paste, align, auto-layout
  from a button.
- "Cited in" markers on spreadsheet cells; cell-by-cell comparison; search in spreadsheets.
- Hover previews for slides and recordings.
- Reopen tabs at the place you left them.
- A designed Find in notes, and spell check.
- Automatic updates and a signed installer.
- Word documents.
- Drag a selection into the note to cite it.

## 4. How each phase is done

- Spec first (`docs/spec/`), then code, then a smoke-test step for every new behaviour.
- A new installer version per phase, published by pushing its tag.
- Nothing is taken from Folio's code; each feature is written fresh from its described behaviour.
