# Locus and Claude

Claude can read a workspace and write notes, tours and flowcharts whose links jump to exact
places. Every link comes from the `make_reference` tool, which checks the target, finds PDF
passages and code lines from a quote, and records the version.

## Connect

**From the app (easiest):** when Locus finds Claude Code or Claude Desktop on the computer, it
offers to connect them; it's also in **Settings → Claude**. Both run the MCP server inside Locus
itself, so neither Node nor git needs installing, and updating Locus updates what Claude uses
(restart Claude Desktop, or open a new Claude Code session).

- Claude Code: installs the Locus plugin into `~/.claude/skills/locus` (a plugin installed from
  the marketplace is updated instead).
- Claude Desktop: adds a `locus` entry to `claude_desktop_config.json`, keeping a backup of the
  original.
- Uninstalling Locus removes both.

**Claude Code by hand:**

```bash
claude plugin marketplace add DanKrsi/locus
claude plugin install locus@locus
```

**Claude Desktop as an extension** (instead of the app's setup): build it with
`npm run build:extension` and double-click `release/locus.mcpb`. It bundles its own git and
doesn't update with the app.

Then, in a workspace folder, ask: "give me a tour of this codebase as a Locus note".

## Tools

| Tool | What it does |
|---|---|
| `workspace_overview` | Files and version history |
| `read_file` | Code with line numbers, PDFs by page, spreadsheets by cell, at any version |
| `search_workspace` | Find text across code, PDFs and spreadsheets |
| `make_reference` | Verified link to lines, a PDF page or quoted passage, a cell range, a heading or a past version |
| `validate_note` / `write_note` | Check every link in a note or flowchart (moved, changed, broken) / save a note and check it |
| `write_flowchart` | Draw a flowchart from boxes, loops and arrows: laid out automatically, with verified citations in the boxes |
| `file_history`, `init_workspace` | Versions of a file; set up history for a plain folder |
