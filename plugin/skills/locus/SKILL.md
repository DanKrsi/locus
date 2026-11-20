---
name: locus
description: Write Locus notes and flowcharts - markdown notes and .canvas flowcharts whose links jump to exact places in a workspace (code lines, PDF pages and highlighted passages, spreadsheet ranges, note sections, past versions of files). Use when asked for a tour or walkthrough of a codebase or folder of documents, a code review write-up, research that answers a question from downloaded sources (gathering them, citing them, walking someone through them), study notes that cite sources, a flowchart or diagram explaining how code or a process works, or any note "with links to where things are".
---

# Locus notes

A Locus note is a plain markdown file in the workspace. Its links are **references**:
clicking one in the Locus app opens the file on the right at the exact spot, with the
cited lines, cells or passage highlighted. The reader sees the real document, not a snippet,
so explain in your own words and let the links show the source.

## Rules

1. **Never hand-write a reference.** Get every link from `make_reference`. It checks that the
   target exists, finds the lines or the page from a quote, and records the version so the
   link survives later edits. Paste its markdown unchanged.
2. **Quote, don't guess.** Read the file first (`read_file`), then pass an exact `quote`:
   - code: the quote finds the lines for you (or pass `lines` you read with line numbers);
   - PDF: the quote finds the page, and `highlight: true` boxes the passage;
   - slides: pass `slide` (a number) or a quote from the slide;
   - spreadsheets: pass `range` ("'Load cases'!B4:D12", "Margins!B2:C6") or a named range.
3. **Check before you finish.** Run `validate_note` (or read the result of `write_note`) and
   fix every link that is not OK. `MOVED` is fine; `CHANGED`, `WARNING` and `BROKEN` need a look.
4. Write each paragraph on a single line. The app's editor shows line breaks exactly as
   written, so hard-wrapped text looks broken.
5. Labels are short and say what the reader will see: "the retry loop", "Table 5",
   "load cases B4:D12". Never use "here" or "this link". Don't put line numbers in a label for
   code ("client.py L12-18"): lines move, and the link follows them.
6. **Show, when seeing it matters.** `make_reference` with `embed: true` puts the place in the
   note instead of a link: a picture of a PDF page (or the highlighted passage) or a slide, or a
   read-only table of a spreadsheet range. Live views follow the file; pass `version` to pin one.
   Put each on a line of its own, and use them sparingly: for the table of numbers the note is
   about, the figure page, the key slide. Code can't be shown this way; link to it.

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

## Flowcharts

Use `write_flowchart` when asked for a flowchart or diagram of how code (or a process) works,
or when control flow with loops and branches is easier to see than to read. It writes a
`.canvas` file that opens on the left in Locus (and in Obsidian), laid out automatically; the
person can rearrange it afterwards.

1. Read the code first (`read_file`). Decide the steps in reading order: entry, the main path,
   branches, loop bodies, exits.
2. One step per box, a few words in plain language ("Open the URL", "Wait with backoff").
   Put the evidence in `cite` on the box (same options as `make_reference`, usually a quote of
   the code); don't paste code into the box text.
3. Shapes: `terminal` for start, return and raise; `decision` for conditions (label the two
   arrows "yes"/"no", or the case names); `io` for reading or writing data; `subprocess` for a
   call explained elsewhere; `note` for a side remark; otherwise the default process box.
4. Loops: define each loop once with its header as the label ("for attempt in range(RETRIES)";
   `parent` for a loop inside another) and set `loop` on the boxes of its body. Add the
   loop-back arrow from the last box of the body to the first, labelled ("next attempt");
   it is drawn dashed up the side of the loop. An arrow from the loop id itself shows what
   happens when the loop finishes ("retries used up").
5. Keep it to roughly 5–15 boxes; for bigger code, chart the part asked about, or make one
   flowchart per function and say how they connect.
6. Read the result of `write_flowchart` (it checks every link) and fix anything flagged. Save
   flowcharts as `notes/<topic>.canvas`; `read_file` on a .canvas gives an outline of its
   boxes, loops and arrows.

## Research: answering a question from sources

Here the workspace is a library and the notes are the product. Downloading a file with curl,
printing a page to PDF with Chrome, saving a page as markdown, quoting and boxing in all of those,
and the CSV, repeated-quote and scan behaviour below were tried. Not tried: OCR with `ocrmypdf`,
recalculating with LibreOffice, and Edge in place of Chrome; check those worked before relying on
them.

**Layout.** `sources/` holds each source as received and is never edited (a citation appends one
invisible id comment to a saved web page; that is expected). `data/` holds tables and models you
build, `notes/` the notes, `images/` figures. Name sources `publisher-title-year.pdf`; a source
that is published again (monthly statistics) is a new dated file, never an overwrite.

**Getting a source in.**
- *A PDF or a data file*: `curl -L -o "sources/<name>" "<url>"`, then `read_file` it to check it
  really has text and the numbers you expect.
- *A web page*: print it to PDF, which freezes the page as it was and keeps its tables and charts,
  and can then be quoted and boxed like any report:
  `"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="<absolute path>.pdf" "<url>"`
  (Edge, `msedge.exe`, is Chromium and should take the same flags; that was not tried). Read the result: cookie banners, paywalls and charts
  that load late print wrongly or not at all. If a page won't print well, scrape it to markdown
  instead (the scraper tool or WebFetch), save it as `.md` whose first line is
  `<!-- Source: <url> · Retrieved: <date> -->`, and cite it by quote.
- *A scan*: `read_file` says "no text layer". OCR it (for example `ocrmypdf`) and use the OCR copy
  as the source; nothing in a scan can be quoted.
- *A workbook you build with a script*: its formulas have no stored values until a spreadsheet
  program calculates them, and `read_file` shows "(not calculated)" (the app shows blanks). Recalculate
  and save (LibreOffice does) before citing cells.
- Keep a **source register**, `notes/Sources.md`: for every source its file, publisher, URL, date
  published, date retrieved, what it is good for, and what to distrust (who paid for it, what it
  doesn't measure, how old it is).

**Citing.**
- Quote the exact words, then `make_reference` with `highlight: true` for a PDF. A paraphrase
  fails, on purpose. If a quote fails, shorten it to a clean fragment; printed web pages put link
  addresses into the text, so quote the part before or after a link, or cite the page. Never
  loosen a quote into your own wording.
- `make_reference` tells you when the same words are on other pages. Prefer the place the figure
  is stated (the table, the body) over its repeat in a summary, and pass `page`.
- A chart or figure has no text to quote. Quote its caption with `highlight: true`, describe in
  your own words what it shows, and say you are reading it from the picture. To let the reader
  see it, show the page with `page` and `embed: true`. (The box cannot be drawn on the chart
  itself from here; the person can draw one in the app with Cite area, or Change area on the view.)
- CSV and workbook cells are cited by `range`; a derived number cites the cells of the model that
  produced it, and each input of the model cites its source.
- Every number in a note has a link. If you cannot link it, say it is your estimate.

**The shapes of note.**
- *An answer*: the question, a short answer, a table `Claim | Evidence | How firm`, then what
  would change the answer. Separate what a source says (linked) from what you conclude (not).
- *A walkthrough of a source*: ordered stops, one idea each, a quote link to the exact place,
  what to notice, the terms explained, the method and its limits. Written for someone who has
  not read the source. Press Tour in the app to step through it.
- *A model*: assumptions each cited, a workbook in `data/`, results that link to its cells, and
  how the answer moves when each assumption does.
- *Where sources disagree*: put them side by side with their dates, areas and definitions, and
  say what could explain the difference before choosing between them.

**Honesty.** Say when evidence is old, thin, or from someone who gains from the answer. Don't cite
from memory or from a search snippet: open the source, read it, then quote it. Links to files that
never change can stay live; pin a link (`version`) when an argument rests on those exact words
and the file is one that gets edited.

## Images and tables

Notes can embed images with `![alt](/images/plot.png)`; they show inline in the app. Add
`#rev=<sha>` to show an image as it was in a past version (e.g. before/after drawings).
Markdown tables render as real tables, and references inside cells stay clickable, which suits
evidence tables (claim | value | reference).

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
| Slides (.pptx) | `slide=6` |
| Note section | `#heading-slug` |
| Media | `t=14:32` |
| Version | `at=<sha>` live link recorded at that version; `rev=<sha>` pinned to that version |

Paths with spaces are wrapped in `<...>`. Paths start with `/` (the workspace root), so moving a
note never breaks its links.
