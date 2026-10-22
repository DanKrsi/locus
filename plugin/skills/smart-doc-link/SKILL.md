---
name: smart-doc-link
description: Write Smart Doc Link notes - markdown whose links jump to exact places in a workspace (code lines, PDF pages and highlighted passages, spreadsheet ranges, note sections, past versions of files). Use when asked for a tour or walkthrough of a codebase or folder of documents, a code review write-up, study or research notes that cite sources, or any note "with links to where things are".
---

# Smart Doc Link notes

A Smart Doc Link note is a plain markdown file in the workspace. Its links are **references**:
clicking one in the Smart Doc Link app opens the file on the right at the exact spot, with the
cited lines, cells or passage highlighted. The reader sees the real document, not a snippet,
so explain in your own words and let the links show the source.

## Rules

1. **Never hand-write a reference.** Get every link from `make_reference`. It checks that the
   target exists, finds the lines or the page from a quote, and records the version so the
   link survives later edits. Paste its markdown unchanged.
2. **Quote, don't guess.** Read the file first (`read_file`), then pass an exact `quote`:
   - code: the quote finds the lines for you (or pass `lines` you read with line numbers);
   - PDF: the quote finds the page, and `highlight: true` boxes the passage;
   - spreadsheets: pass `range` ("'Load cases'!B4:D12", "Margins!B2:C6") or a named range.
3. **Check before you finish.** Run `validate_note` (or read the result of `write_note`) and
   fix every link that is not OK. `MOVED` is fine; `CHANGED`, `WARNING` and `BROKEN` need a look.
4. Write each paragraph on a single line. The app's editor shows line breaks exactly as
   written, so hard-wrapped text looks broken.
5. Labels are short and say what the reader will see: "the retry loop", "Table 5",
   "load cases B4:D12". Never use "here" or "this link".

## Workflow for a tour

1. `workspace_overview` to see the files and the version history.
2. Skim the important files with `read_file` / `search_workspace`. Decide on a reading order
   that builds understanding: entry points and big picture first, then the parts in the order
   data or control flows through them, then edge cases.
3. Write the note as numbered or headed **stops**. Each stop: one or two sentences of
   explanation in plain words, one reference to the exact place, then what to notice there.
   One idea per stop; one reference per claim. Keep the reader moving forward.
4. For history ("how did this used to work?"), use `file_history` to find the version, read it
   with `read_file` + `version`, and cite it with `make_reference` + `version` (a pinned link).
   Pair it with a live link to the current code so the reader can click between them.
5. Save with `write_note` (default location `notes/<topic>.md`) and fix anything it flags.

## Example stop

```markdown
### 3. Retries back off exponentially

`fetch` no longer sleeps a fixed 2 s between attempts. It waits a random time up to a ceiling
that doubles on each attempt: [the backoff helper](/src/net/client.py#L15-L18&at=0e781350ad).
Before March 10 it was [a fixed sleep](/src/net/client.py#L12-L18&rev=c0106ece63). The cap of
five attempts comes from [BDS-100 §4.2](</docs/BDS-100.pdf#page=5&viewrect=69,106,457,33&at=0e781350ad> "Retries of a failed proof test shall not exceed three attempts").
```

## Link format (for reading existing notes)

`[label](/path/from/workspace/root#location&at=<sha> "quote")`

| Target | Location |
|---|---|
| Code / text | `L12-L18` |
| PDF page / area | `page=5`, `page=5&viewrect=x,y,w,h` (points from the page's top-left) |
| Spreadsheet | `'Sheet name'!B4:D12`, `Sheet!4:12`, or a named range |
| Note section | `#heading-slug` |
| Media | `t=14:32` |
| Version | `at=<sha>` live link recorded at that version; `rev=<sha>` pinned to that version |

Paths with spaces are wrapped in `<...>`. Paths start with `/` (the workspace root), so moving a
note never breaks its links.
