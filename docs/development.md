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
npm run test:mcp          # call every MCP tool against the test workspace
npm run build:plugin      # rebuild plugin/server/server.mjs (commit it)
npm run build:extension   # pack release/locus.mcpb for Claude Desktop
npm run dist              # build the Windows installer into release/
npm run test:isolated     # test the shipped plugin and extension outside the repo
```

The installer installs for the current user (no admin rights), adds Start menu and desktop
shortcuts, opens `.locus` files and handles `locus://` links. Everything it needs, git included,
is inside.

## Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```
git tag v0.2.13
git push origin v0.2.13
```

The [Release workflow](../.github/workflows/release.yml) builds the installer on GitHub and
publishes the release with `Locus-Setup-<version>.exe` and the demo `Locus-demo.locus` (carried
over from the previous release). To release a tag that already exists, run the workflow from the
Actions tab and enter the tag.

## Where things are

- `src/main` — Electron main process: files, git (bundled through dugite), sharing, Claude setup
- `src/renderer` — the window: notes editor, flowchart editor, viewers
- `src/core`, `src/shared` — the link format and other shared logic
- `src/mcp` — the MCP server Claude uses; `plugin` — the Claude Code plugin it ships in
- `docs/spec` — [link format](spec/link-format.md) and [UI](spec/ui.md) specs; also
  [decisions](decisions.md) and [roadmap](roadmap.md)
