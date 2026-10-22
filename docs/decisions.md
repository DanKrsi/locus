# Decisions

Short record of the choices made while planning, and why.

| Decision | Why |
|---|---|
| Standalone desktop app, not an add-on | Target users are non-technical; they shouldn't need VS Code or Obsidian. Add-ons can't own the layout (version picker, viewers). |
| Electron (bundled Chromium) rather than Tauri | The biggest pain with the work prototype was machines having different versions of Python/Edge/Windows. Electron ships its own engine, so it renders the same everywhere. |
| Windows first | Halves packaging and signing work. Mac later. |
| Everything bundled, including git | No Python, Node or git on the user's machine. Git via `dugite` (the approach GitHub Desktop uses). |
| Link format = plain markdown links | Notes stay readable and portable; works on GitHub. Borrows GitHub `#L`, PDF `page=`/`viewrect=`, Excel references. Compatible with Folio notes. |
| Root-relative paths (`/docs/x.pdf`) | Moving a note never breaks its links. |
| Every reference records a version (`at=` or `rev=`) | Lets the app follow renames, map shifted lines, and recover deleted files. |
| "What you see is what you cite" | Viewing an older version writes a pinned link; viewing the latest writes a live link. No separate setting. |
| Workspace = one folder with one history | Notes and cited files live together; keeps links stable and sharing simple. Multiple repos per workspace is a later feature. |
| Simple vs Git terminology setting | Non-technical users see "versions" and "sync"; developers see commits, pull and push. |
| Sharing: `.locus` package first, then GitHub | Package works with no accounts; GitHub (device-flow sign-in, no client secret) for ongoing collaboration. |
| Don't share `.git` through OneDrive | Synced `.git` folders corrupt. OneDrive users keep history locally. |
| Clean-room implementation, new name | The work version (Folio) belongs to the employer; nothing is copied from it. |
| Name: Locus | Latin for "the exact place": every link points at the exact place in a document or version. Short and easy to spell. Checked against notes, markdown and document apps; the only other use found is Locus Map, a hiking GPS app. |
| Code lives outside OneDrive (`C:\dev`) | OneDrive sync fights with `.git` and `node_modules`. |
