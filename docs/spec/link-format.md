# Link format spec (v1)

Status: draft · Name: Locus

A **reference** is an ordinary markdown link whose destination points at a file in the
workspace plus a location inside it. Notes stay plain `.md` files; nothing is stored anywhere
else. Any markdown tool can read them, GitHub can follow most of them, and the app can always
get back to the exact spot.

```markdown
[backoff loop](/src/net/client.py#L40-L72&at=3f2a9c1e08 "for attempt in range(retries)")
\____label___/ \____path________/ \__location__/\__version__/ \_______quote_______________/
```

## 1. Workspace

- A **workspace** is one folder with one version history (a git repository). Notes and the
  files they cite live inside it.
- The workspace root is the nearest ancestor folder containing `.locus/`. Opening a plain
  folder creates `.locus/workspace.json` and, if needed, a git repository.
- `.locus/workspace.json` holds `{ "format": 1, "name": "<display name>" }`.
  `.locus/cache/` is local-only and git-ignored.

## 2. Destination

### 2.1 Path

| Form | Meaning | Written by the app? |
|---|---|---|
| `/docs/spec.pdf` | Relative to the **workspace root** | Yes (default) |
| `docs/spec.pdf`, `../spec.pdf` | Relative to the note's folder | No, but always read (Folio compatibility) |
| `file:///C:/Users/me/spec.pdf` | **External** file outside the workspace | Only when citing an external file |
| `https://…` | Web page | Not a reference; treated as a normal link |

- Root-relative paths mean **moving a note never breaks its links**. GitHub also resolves a
  leading `/` against the repository root.
- Paths use `/` separators. When a destination contains spaces or parentheses the app writes
  it in angle brackets: `[Loads](</data/Bracket loads.xlsx#Loads!B4:D12>)`. Readers also
  accept `%20` encoding.

### 2.2 Fragment (location + version)

The fragment is a list of parts joined by `&`. The first part is usually the location; the
others are `key=value` pairs in any order.

| Target | Location syntax | Example |
|---|---|---|
| Code / text | `L<n>` or `L<a>-L<b>` (GitHub style) | `#L12-L18` |
| PDF page | `page=<n>` (1-based page in the file) | `#page=18` |
| PDF area | `page=<n>&viewrect=<left>,<top>,<width>,<height>` in PDF points from the page's top-left | `#page=12&viewrect=72,140,300,95` |
| Slide deck | `slide=<n>` | `#slide=4` |
| Spreadsheet | Excel reference: `Sheet!A1:B2`, `'Sheet name'!A1`, `Sheet!4:12`, `Sheet!F:H`, or a named range | `#'Load cases'!B4:D12` |
| Markdown note | GitHub heading slug | `#design-basis` |
| Audio / video | `t=<seconds>` or `t=<m:ss>` / `t=<h:mm:ss>` | `#t=14:32` |
| Image | `rect=<x>,<y>,<w>,<h>` in image pixels | `#rect=40,60,200,120` |

Spreadsheet parsing: a part starting with `'` runs to the closing quote (`''` is an escaped
quote) followed by `!range`. Otherwise a part containing `!` is a sheet reference, and a bare
identifier on a spreadsheet target is a named range.

### 2.3 Version parts

| Part | Meaning |
|---|---|
| `rev=<sha>` | **Pinned.** Always show the file exactly as it was at that version. |
| `at=<sha>` | **Live.** Show the latest file. The location was recorded at `<sha>`, so the app can map it forward if the file changed. |

- SHAs are written as 10 hex characters; readers accept 7–40.
- A pinned link interprets the **path at that version**, so moving or deleting the file later
  can never break it.
- Which one gets written follows "what you see is what you cite": viewing the latest version
  writes `at=`, viewing an older version writes `rev=`.
- If the cited file has changes that aren't in a version yet, the app first saves an
  automatic version so the SHA always exists (see §5).

### 2.4 Title (quote)

The optional link title holds text selected in the document when citing (max 200 characters,
`"` escaped as `\"`). It's shown in the hover card, shown as a tooltip by GitHub, and used as
a fallback anchor when the location no longer matches.

## 3. Labels

When citing:
1. If text is selected **in the note**, it becomes the label.
2. Otherwise the app proposes a default label, pre-selected so typing replaces it and Enter
   keeps it:

| Target | Default label |
|---|---|
| PDF page / area | `<file stem> p<n>` (printed page label when the PDF has one) |
| Slide | `<file stem> slide <n>` |
| Code | `<file name> L<a>-<b>` |
| Spreadsheet | `<file stem> <reference>` |
| Note heading | `<heading text>` |
| Media | `<file stem> <m:ss>` |

## 4. Resolving a reference

1. **Resolve the path.** Root-relative → workspace root; note-relative → note folder;
   `file:` → external.
2. **Pinned (`rev=`)**: read the file at that version (`git show <sha>:<path>`). Done.
3. **Live**: read the working file.
   - If `at=` is present and the file changed since then, **map the location forward**:
     - code/text: walk the diff hunks from `at` to the working file and shift/clip the line range;
     - PDF/docx: search for the quote near the original page;
     - spreadsheet: named ranges resolve directly; plain ranges are kept and the quote, if any, is checked.
4. **Missing file**: follow renames in history from `at` (or the last version that had the
   path). If found → status `moved`, offer **Fix links**. If deleted → status `deleted`, offer
   **Open last version**.

Statuses surfaced in the UI: `ok`, `remapped`, `changed`, `moved`, `deleted`, `missing`, `external`.

## 5. Automatic versions

- **Simple mode / app-managed workspaces**: an automatic version is a normal commit with the
  message `Automatic version (cited <file>)`.
- **Repos with their own history (developer mode)**: automatic versions are written as
  commits on `refs/locus/snapshots` (not on any branch), so the developer's branch history
  stays clean. Sharing pushes `refs/locus/*` along with branches.

## 6. Keeping links healthy

- Renaming or moving a file **inside the app** rewrites every reference in the workspace.
- Files moved outside the app are detected through git rename detection at the next version;
  the app offers to fix the affected links.
- The app keeps a local index (`.locus/cache/`) of all references for "Cited in" markers,
  backlinks, and link health.

## 7. Outside the app

- `#L12-L18`, `#page=18` and `#design-basis` work on GitHub and most viewers as-is.
- **Export → GitHub permalinks** rewrites references to
  `https://github.com/<owner>/<repo>/blob/<sha>/<path>#L12-L18` for sharing outside the app.
- **Export → portable** copies external files into the workspace and rewrites the links.
