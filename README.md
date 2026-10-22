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

Early development (milestone 1). Windows first. Working today:

- Open any folder as a workspace (version history is set up automatically, git is bundled)
- Notes editor with live preview; references render as icons + labels with hover previews
- Viewers: PDF (pages, area highlights, text selection), code (syntax highlighting, line
  ranges), spreadsheets (.xlsx/.csv, Excel-like grid, named ranges), images, audio/video
- **Cite** (Ctrl+Shift+L) inserts a reference with an inline rename box; clicking it jumps back
- Version picker, per-file version strip, pinned (`rev=`) and live (`at=`) references, with
  live code references following lines that moved
- Simple / Git terminology setting, five themes, dark mode

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

## Development

```bash
npm install
npm start                 # build and launch the app
npm test                  # unit tests for the link format
npm run test-workspace    # create ../locus-test-workspace with sample history
npm run smoke             # drive the app against it and save screenshots to test-output/
npm run test:mcp          # call every MCP tool against the test workspace
npm run build:plugin      # rebuild plugin/server/server.mjs (commit it)
npm run build:extension   # pack release/locus.mcpb for Claude Desktop
npm run test:isolated     # test the shipped plugin and extension outside the repo
```

## License

MIT
