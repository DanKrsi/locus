# Roadmap

Decisions so far live in [decisions.md](decisions.md); the specs are in [spec/](spec/).

## Milestone 1: core loop (in progress)

- [x] Link-format and UI specs
- [x] Electron app shell: open workspace, file tree, two panes, tabs
- [x] Markdown editor with live preview and references
- [x] Viewers: code/text, PDF (page + area), spreadsheet (range)
- [x] Cite flow with inline rename; click a reference to jump back
- [x] Hover card
- [x] Version picker, pinned (`rev=`) and live (`at=`) references, automatic versions
- [x] Terminology setting (Simple / Git)
- [x] Test workspace generator

## Milestone 2: Claude

- [x] MCP server: overview, read (code/PDF/sheet, any version), search, make_reference (quote → PDF area / code lines), validate, history, write, init
- [x] Skill teaching the link format and how to write a good tour; same guidance as a `write_tour` MCP prompt for Claude Desktop
- [x] Claude Code plugin (this repo is its marketplace) + Claude Desktop extension (.mcpb with bundled git)
- [ ] `open_in_app`: let Claude drive the running app during a tour (needs a local channel into the app)
- [ ] Publish the .mcpb on GitHub Releases

## Milestone 3: versions in depth

- [x] Compare view: code as a side-by-side diff; PDFs, spreadsheets and images as two viewers. From the version strip or a pinned link's hover card
- [x] Rename/move files and folders in the app, rewriting live links (pinned links keep the path from their version)
- [x] Files moved outside the app: detected by git rename detection or identical content; "Fix links" notice
- [x] "Cited in": list per document, PDF margin bookmarks, code gutter bookmarks (live code links follow moved lines)
- [x] Tour mode: step through a note's references with ←/→ (Ctrl+Shift+T)
- [ ] Cell-level diff for spreadsheets; "Cited in" markers on spreadsheet cells
- [ ] One intermittent smoke-test failure seen in ~1 of 12 runs, not yet reproduced

## Milestone 4: sharing

- [x] Single-file `.locus` package (git bundle): Share → Send as a file; Welcome → Open a shared file
- [x] Sync with an online copy: sync pill (Synced / Changes to share / Updates available), friendly conflicts (Keep mine / theirs / both)
- [x] GitHub: device-flow sign-in, private repo creation, invites, download from GitHub, locus:// open links. Tested live: sign-in, private repo, download, sync both ways (invites need a second account to test)
- [ ] Auto-sync in the background
- [ ] GitLab, GitHub Enterprise, Azure DevOps

## Milestone 5: more formats and polish

- PowerPoint (via installed PowerPoint, with a fallback), Word, images, audio/video, web pages
- Windows installer, code signing, auto-update, Explorer "Open in" menu, file associations
- Mac build; VS Code extension built on `src/core`

## Known gaps in milestone 1

- PDF search (Ctrl+F) and printed page labels in the toolbar need more testing
- Tables in notes show as markdown source (no table editor yet)
- Images in notes are not rendered inline yet
- Link to section dialog (Ctrl+Alt+L), tab drag-to-reorder, drag-to-cite
- Packaging: `dugite` must be unpacked from asar when building the installer
