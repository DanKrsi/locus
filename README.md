# Locus

Write markdown notes on the left, read the source on the right, and link to the **exact
spot**: a PDF page or highlighted area, lines of code, a range of spreadsheet cells, a
moment in a recording. Because the workspace keeps a version history, a link can also point
at **a past version** of a file, so you can walk someone through how something changed.

Notes stay plain `.md` files. References are ordinary markdown links:

```markdown
The cap comes from [BDS-100 p5](</docs/BDS-100.pdf#page=5&at=71b9e88e01> "Retries … shall not exceed three attempts").
Before the refactor it was [a fixed sleep](/src/net/client.py#L12-L18&rev=2173d2caea).
Loads are in [LoadTable](</data/Bracket loads.xlsx#LoadTable&at=71b9e88e01>).
```

- Specs: [link format](docs/spec/link-format.md) · [UI](docs/spec/ui.md)
- [Decisions](docs/decisions.md) · [Roadmap](docs/roadmap.md)

## Status

Early development (milestones 1–3 done). Windows first. Working today:

- Open any folder as a workspace (version history is set up automatically, git is bundled)
- Notes editor with live preview; references render as icons + labels with hover previews
- Viewers: PDF (pages, area highlights, text selection), code (syntax highlighting, line
  ranges), spreadsheets (.xlsx/.csv, Excel-like grid, named ranges), PowerPoint (slides),
  images, audio/video
- Notes show embedded images and render markdown tables (with clickable links in cells);
  **Open note** (Ctrl+O) on the left, **Open document** (Ctrl+P) on the right
- **Cite** (Ctrl+Shift+L) inserts a reference with an inline rename box; clicking it jumps back
- Version picker, per-file version strip, pinned (`rev=`) and live (`at=`) references, with
  live code references following lines that moved
- **Compare** two versions side by side (a diff for code)
- **Rename or move** files and folders in the app and every live link follows; files moved
  outside the app are detected and offered a one-click **Fix links**
- **Cited in**: see which notes cite a document, with bookmarks in PDF margins and code gutters
- **Tour mode** (Ctrl+Shift+T): step through a note's references with the arrow keys
- **Share** as a single `.locus` file (with full history), or sync through a private GitHub
  repository with invites and friendly conflict handling
- Simple / Git terminology setting, five themes, dark mode

## Sample project

`npm run sample` builds `../locus-sample`: a small CubeSat bracket project with real NASA
standards (NASA-STD-5001B in two editions, NASA-STD-5020B), Python code, Excel workbooks, a
PowerPoint deck, images, a spoken meeting recording and a version history from January to
April. Its notes use every kind of link; start with `notes/00 Start here.md`.

## Claude integration

Claude can read a workspace and write notes and tours whose links use this format. Every link
comes from the `make_reference` tool, which verifies the target, finds PDF passages and code
lines from a quote, and records the version.

| Tool | What it does |
|---|---|
| `workspace_overview` | Files and version history |
| `read_file` | Code with line numbers, PDFs by page, spreadsheets by cell, at any version |
| `search_workspace` | Find text across code, PDFs and spreadsheets |
| `make_reference` | Verified link to lines, a PDF page or quoted passage, a cell range, a heading or a past version |
| `validate_note` / `write_note` | Check every link in a note (moved, changed, broken) / save a note and check it |
| `file_history`, `init_workspace` | Versions of a file; set up history for a plain folder |

**Claude Code** (plugin with the MCP server and a skill that teaches how to write a good tour):

```bash
claude plugin marketplace add DanKrsi/locus
claude plugin install locus@locus
```

Then, in a workspace folder: "give me a tour of this codebase as a Locus note".

**Claude Desktop**: build the extension with `npm run build:extension` and double-click
`release/locus.mcpb`. It bundles its own git, so nothing else needs installing. Use the
"Write a tour" prompt from the + menu.

## Install (Windows)

Build the installer with `npm run dist`, then run `release/Locus-Setup-<version>.exe`. It installs
for the current user (no admin rights), adds Start menu and desktop shortcuts, opens `.locus`
files, and handles `locus://` links. Everything it needs, including git, is inside.

The installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC"
the first time: click **More info** → **Run anyway**.

## Development

```bash
npm install
npm start                 # build and launch the app
npm test                  # unit tests for the link format
npm run test-workspace    # create ../locus-test-workspace with sample history
npm run smoke             # drive the app against it and save screenshots to test-output/
npm run test:sharing      # package, sync and conflicts against a local stand-in for GitHub
npm run test:mcp          # call every MCP tool against the test workspace
npm run build:plugin      # rebuild plugin/server/server.mjs (commit it)
npm run build:extension   # pack release/locus.mcpb for Claude Desktop
npm run dist              # build the Windows installer into release/
npm run test:isolated     # test the shipped plugin and extension outside the repo
```

## License

MIT
