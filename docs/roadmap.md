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

- MCP server (find quote in PDF → page + area, make link, validate links, git history, open in app)
- Skill teaching the link format and how to write a good tour
- Claude Code plugin + Claude Desktop extension

## Milestone 3: versions in depth

- Version strip per document, Compare view, location mapping across versions
- Rename/move tracking and Fix links; "Cited in" markers and backlinks
- Tour mode

## Milestone 4: sharing

- Single-file `.sdl` package (git bundle)
- GitHub sign-in (device flow), Share / Invite / Sync, friendly conflicts
- GitLab, GitHub Enterprise, Azure DevOps

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
