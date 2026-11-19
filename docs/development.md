# Development

Locus is an Electron app (React, CodeMirror, PDF.js) for Windows. You need a current LTS release of Node.js.

```bash
npm install
npm start                 # build and launch the app
npm test                  # unit tests for the link format
npm run sample            # build ../locus-sample, the demo workspace
npm run test-workspace    # create ../locus-test-workspace with sample history
npm run smoke             # drive the app against it and save screenshots to test-output/
npm run test:sharing      # package, sync and conflicts against a local stand-in for GitHub
npm run test:chaos        # a messy week in the demo workspace: does any link break?
npm run test:mcp          # call every MCP tool against the test workspace
npm run build:plugin      # rebuild plugin/server/server.mjs (commit it)
npm run build:viewer      # the viewer that ships inside an exported folder
npm run build:extension   # pack release/locus.mcpb for Claude Desktop
npm run dist              # build the Windows installer into release/
npm run fetch-release     # download a published release's installer into release/
npm run test:isolated     # test the shipped plugin and extension outside the repo
```

`test:chaos` is a read of how the app behaves rather than a pass/fail suite. It makes a fresh demo
workspace and plays a user having a rough week in it — renaming and moving documents, editing code,
duplicating a workbook, swapping a PDF for another edition, deleting a cited recording, moving a
folder in Explorer, renaming the note everything points at, restarting mid-sentence — and after
every step it prints what the app said and lists any link a user would call broken. Screenshots of
each step land in `test-output/chaos/`. Run it on a machine with nothing else driving the app: a
second copy sharing the same user data will close the first.

The installer installs for the current user (no admin rights), adds Start menu and desktop
shortcuts, opens `.locus` files and handles `locus://` links. Everything it needs, git included,
is inside.

## Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```
git tag v0.3.1
git push origin v0.3.1
```

The [Release workflow](../.github/workflows/release.yml) builds the installer on GitHub and
publishes the release with `Locus-Setup-<version>.exe`, its `.blockmap` and `latest.yml` (what installed
copies read to update themselves, see the UI spec §6.2), and the demo `build/Locus-demo.locus` (which
also ships inside the installer; rebuild it with `npm run sample` and **Share → Send as a file**). To release a tag that already exists, run the workflow from the
Actions tab and enter the tag.

The installer is built on the runner, so nothing lands in `release/` here. To keep the published
file (the very one people download, rather than a local build of the same code):

```
npm run fetch-release                  # the version in package.json
npm run fetch-release -- latest        # whatever is newest
npm run fetch-release -- v0.6.1 --all  # that tag, installer and demo
```

It checks the size against the release, writes through a `.part` file so a broken download is
never left looking finished, and skips a file that is already there.

## Where things are

- `src/main` — Electron main process: files, git (bundled through dugite), the watch on the open
  workspace (`watch.ts`), sharing, Claude setup
- `src/renderer` — the window: notes editor, flowchart editor, viewers
- `src/core`, `src/shared` — the link format and other shared logic
- `src/mcp` — the MCP server Claude uses; `plugin` — the Claude Code plugin it ships in
- `docs/spec` — [link format](spec/link-format.md) and [UI](spec/ui.md) specs; also
  [decisions](decisions.md) and [roadmap](roadmap.md)
