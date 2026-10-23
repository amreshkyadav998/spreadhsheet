# Design notes

All five challenges are on one branch (`challenges`) as one PR, as the invitation asked. `npm test` (80 tests, including both golden sets end to end), `npm run lint` and `npm run build` pass. There is no backend; the app runs fully in mock mode.

Where things live:

| Layer | Files | React? |
|---|---|---|
| Engine | `src/engine/core.js` (state, transactions, recalc, structure, sort, filter state), `formula.js` (parser, evaluator, reference rewriting), `values.js` (coercion), `fill.js`, `sort.js`, `filter.js`, `format.js` | no |
| AI logic | `src/ai/parse.js`, `validate.js`, `executor.js`, `formatApplier.js`, `context.js`, `prompt.js`, `describe.js`, `assistant.js`, `provider.js`, `queryRunner.js` + `query.worker.js` | no |
| UI | `src/App.jsx`, `src/ui/Grid.jsx`, `FilterMenu.jsx`, `AiPanel.jsx`, `FormulaBar.jsx`, `layout.js`, `stores.js` | yes |

Nothing under `src/engine` or `src/ai` imports React or touches the DOM. The worker, `measure.js` (canvas) and the panel are the only browser-specific pieces, and they sit outside the engine.

## Challenges

- **1. Selection and fill handle.** Selection is `{ anchor, focus }` in `App`. Single click selects; double-click, Enter, F2 or typing edits (typing replaces, F2/double-click edit in place). Supported: drag, Shift+Click, Shift+Arrow, row/column header click (and drag), the corner (all), Ctrl+A (used range), Ctrl+arrows (data edge), Delete/Backspace (one undo step). Formatting applies to the whole selection. The fill handle snaps to the axis the pointer left the selection along (`fillTargetFor`), shows a dashed preview, and on release calls `engine.fill`. Series rules are in `src/engine/fill.js` (`analyzeSeeds`). Dragging back inside the selection clears the cells left out.
- **2. Sort and filter.** Filters are engine state (so they undo) but only *hide* rows: `getHiddenRows()` is derived per version, hidden rows get height 0 in the layout, and row numbers show gaps. The header ▾ opens `FilterMenu`: search, distinct values grouped by `norm()` (so `West`, `West ` and `west` are one entry, which answers the acceptance question), `(Blanks)`, and the conditions contains / greater than / less than / is empty. Per-column clear and clear-all are there, and the status bar shows `28 of 32 rows`. Sort is the header ↕ button: ascending → descending → original order. It is a physical permutation of whole rows (cells, styles, heights, row ids). Formulas are rewritten so references follow their rows.
- **3. Virtualized grid.** The grid is 100,000 × 200 by default. `src/ui/layout.js` keeps prefix sums (`Float64Array`) and binary search for row and column offsets. Rendering covers only the visible window plus overscan, and the window is derived from a quantized scroll position, so most scroll events cause no React render at all. Frozen rows and columns are `position: sticky` panes in the same scroll container, so the browser keeps them in sync with no scroll JavaScript. Column resize: drag the header border; double-click it to auto-fit. Row height: drag the row header border. The name box accepts `AZ5000` or `K2:K100000`. Ctrl+Home/End, PageUp/Down and arrows skip hidden rows. There is no React state per cell: cells are read from the engine during render. The editor text lives in an external store, so a keystroke re-renders only the editor and the formula bar.
- **4. Ask your data.** Prompt → `ask()` (provider → `extractJson` → `validateAction`) → `executeQuery` (in a worker when the sheet has ≥ 20,000 rows) → result card. The card has the table, row count, a plain-words description built from the plan, show plan, Re-run (no model call), and Insert into sheet (one undo step) at a chosen cell. Unknown columns become a question to the user listing the real columns.
- **5. Format with AI.** `format_sheet` → `planFormat` (pure, AI_CONTRACT §4) → preview text (`describeFormat`) plus the `OK` / `NO_CHANGES` / `OUT_OF_RANGE` result → Apply (re-plans against the current sheet, then `engine.applyFormatPatch` = one undo step) or Discard.

## Data model changes

The engine was rebuilt around one idea: **all positional state lives in the engine and moves through one primitive.**

- `cells: Map<id, { raw, value, error, f }>` with numeric ids `row * 16384 + col` (strings like `"A1"` were the old key). `f` is the compiled formula (AST plus its precedents). A literal's `value` is a number only when the text is a plain number; `"$1,200.00"`, `"10%"` and `"2024-01-03"` stay text, and formulas coerce them when they compute.
- `styles: Map<id, partialStyle>` holds only non-default keys (`bold italic underline bg color align fontSize numberFormat`). Styles moved from React state into the engine so they undo and follow structure.
- `rowSizes` / `colSizes: Map<index, px>` hold overrides only. `frozen: { rows, cols }`.
- `rowIds: number[]` gives each row a stable identity. Sort's "original order" is stored as the list of row ids from the first click, so it survives edits between clicks.
- `filters: Map<col, { values: string[] | null, cond: { op, value } | null }>` and `sortState: { r1, r2, col, dir, order }`.
- **Dependency graph:** point references live in `Map<precedent, Set<dependent>>`. Ranges are **not expanded**: each range is one rectangle entry in a per-column bucket, so `=SUM(J2:J100000)` is one entry and an interior edit still finds it. Recalculation walks dependents from the changed cells with an iterative DFS (reverse post-order = topological order), marks back-edges as `#CYCLE!`, and evaluates only that set. There is no recursion, so a 20,000-deep chain works (tested).
- **Transactions:** every public mutation runs in `transact(label, fn)`, which records reversible changes (`cell`, `style`, `size`, `frozen`, `filters`, `sortState`, `remap`). One transaction = one undo entry. Nested calls join the outer one, and a throw rolls the partial change back. No-op transactions leave no undo entry.
- **Remap:** insert, delete and sort are all `remap(axis, op)` with `op` = `insert` / `delete` / `permute`. It moves cells, styles, sizes, filters and row ids together and is exactly invertible. Formula rewriting after a remap is recorded as ordinary `cell` changes, so undo restores the original formula text byte for byte. Delete first clears the row (recorded), so the remap itself never loses data.

## Engine API

`createEngine(rows = 50, cols = 50)` returns the object below. All `range` arguments are `{ r1, c1, r2, c2 }` (0-based, inclusive). "Undo" says what one Ctrl+Z reverts.

| Method | What it does | One undo reverts |
|---|---|---|
| `rows`, `cols`, `version`, `frozen`, `undoDepth` | Read-only getters (`version` bumps on every committed change) | — |
| `subscribe(fn) → unsubscribe` | Called after every committed change, undo and redo | — |
| `getCell(r, c) → { raw, computed, error }` | Original API, unchanged shape | — |
| `getRaw(r, c)` / `getValue(r, c)` / `getText(r, c)` | Raw text / computed value (number, string, `''`, or error code) / data text (literal as typed, formula result) | — |
| `getDisplay(r, c)` | What the grid shows: error, or the value under the cell's number format | — |
| `getRangeValues(range)` | 2-D array of `getText` | — |
| `getUsedRange()` / `getTotalsRow()` | Bounding box of non-empty cells / last used row if it reads "Total…" | — |
| `setCell(r, c, raw)` | Edit one cell | that edit |
| `setCells([{ row, col, raw }], label)` / `writeBlock(r, c, matrix, label)` | Many cells as one step (paste, load, Insert into sheet) | all of them |
| `clearContents(range)` | Delete/Backspace; formatting is kept | the whole clear |
| `clearAll()` | Contents, styles, filters, sort cycle | everything it cleared |
| `fill(source, target, { copy })` | Fill handle (series) or Ctrl+D/Ctrl+R (`copy: true`); target inside source shrinks | all written and cleared cells and their styles |
| `batch(label, fn)` | Run several calls as one step | everything inside |
| `getStyle(r, c)` / `getStoredStyle(r, c)` | Merged with defaults / stored partial or `null` | — |
| `setStyle(range, patch)` / `clearStyles(range)` | Merge a style patch into / remove styles from every cell of a range | the whole range |
| `applyFormatPatch({ styles, freezeRows, colWidths }, label) → changed` | Applies a precomputed patch (AI format); no entry if nothing changed | the whole patch |
| `getColWidth(c)` / `getRowHeight(r)` / `getSizeOverrides(axis)` | Sizes (defaults 100 / 24) | — |
| `setColWidth(c, px)` / `setRowHeight(r, px)` | Resize / auto-fit | that resize |
| `setFrozen({ rows, cols })` | Freeze panes | that change |
| `insertRow(at, n)` / `deleteRow(at, n)` / `insertColumn(at, n)` / `deleteColumn(at, n)` | Structure: cells, styles, sizes, filters, row ids and formulas follow; deleted references become `#REF!` | the whole operation incl. formula rewrites |
| `ensureCapacity(rows, cols)` | Grow bounds (sparse, allocates nothing) | not undoable |
| `getRowId(r)` | Stable row identity | — |
| `getFilters()` / `setFilter(col, filter \| null)` / `clearFilters()` | Column filters (a view) | that filter change |
| `getHiddenRows()` / `getFilterStatus()` | Rows hidden by filters / `{ visible, total, active }` | — |
| `getSortBlock(selection)` | Multi-row selection, or used range minus header and trailing totals row | — |
| `sortRows(block, col, 'asc' \| 'desc' \| 'original')` | Stable sort of visible rows of the block | the sort |
| `cycleSort(col, selection) → dir` | Header click: asc → desc → original | that one click |
| `getSortState()` | `{ col, dir, r1, r2 }` for the header indicator | — |
| `undo()` / `redo()` / `canUndo()` / `canRedo()` / `undoLabel()` / `redoLabel()` | History (200 entries) | — |

Pure helpers exported for tests and the AI code: `values.js` (`toNum`, `toDate`, `norm`, `classify`, `parseDateParts`), `formula.js` (`parse`, `compile`, `evaluate`, `rewriteRefs`, `shiftFormula`, `parseRangeName`, `cellName`), `fill.js` (`analyzeSeeds`, `planFill`, `fillTargetFor`), `sort.js` (`orderRows`, `compareKeys`), `filter.js` (`matchesFilter`, `distinctValues`), `format.js` (`formatValue`, `DEFAULT_STYLE`).

## Undo semantics

| User action | One Ctrl+Z reverts |
|---|---|
| Edit a cell (editor, formula bar) | that cell |
| Delete/Backspace on a selection | every cleared cell |
| Toolbar formatting / Ctrl+B/I/U on a selection | the style of every selected cell |
| Fill handle drag (extend or shrink), Ctrl+D, Ctrl+R | every filled/cleared cell and the copied styles |
| Sort click (each of asc / desc / original) | that reorder, its formula rewrites and the sort-cycle state |
| Filter apply / clear column / clear all | the filter state only (no data changed) |
| Insert/delete row or column | the structure change, moved styles and sizes, and every rewritten formula |
| Column resize / auto-fit / row resize | that size |
| Freeze change | the freeze |
| Paste | the whole pasted block |
| Load sample | the whole load (sheet back to what it was) |
| AI Insert into sheet | the whole inserted table |
| AI format Apply | every style, the freeze and the widths of that action; `NO_CHANGES` adds no entry |

## Defects found in the existing code

1. **Ranges never parsed** (`core.js` `parseTokensToAST`). Symptom: `=SUM(A1:A2)*2` gave `#PARSE!`, and the starter test failed. Root cause: the shunting-yard loop handles `:` as soon as it reads it, before the right-hand cell has been pushed, so `outputQueue.length < 2` throws. Fix: replaced with a recursive-descent parser where `ref ':' ref` is a primary.
2. **Literals coerced with `parseFloat`** (`resolveCellValue`). Symptom: `2024-01-03` displayed and sorted as 2024, `1/8/2024` as 1, `10%` as 10. Root cause: `parseFloat` reads a numeric prefix. Fix: a literal is a number only if it is entirely a plain number. Everything else stays text and is coerced by formulas, sort, filter and the executor through one `toNum`/`toDate`.
3. **Ranges tracked by endpoints only** (`extractCellReferences`). Symptom: editing A3 did not update `=SUM(A1:A5)`. Root cause: the regex collects `A1` and `A5`, never the interior. Fix: ranges are rectangle dependencies in column buckets.
4. **Every edit invalidated the whole cache.** `executeSetCell` bumps `_generation`, which makes every cached value stale, so each render re-evaluated the sheet recursively. `recalculate` also used `sorted.includes` (O(n²)) and recursion (stack overflow on long chains). Fix: eager, incremental recalculation of the dependents of changed cells only, in iterative topological order.
5. **Deleting a row re-pointed references instead of `#REF!`** (`shiftCellReferences`). Symptom: `=A3*2` silently became the row below's value after deleting row 3. Root cause: references `>= at` all shift by −1, including those to the deleted row. Fix: references into deleted cells become `#REF!`, and ranges shrink.
6. **Reference shifting was a regex over the whole formula.** It ignored `$` and would also rewrite text inside string literals or names like `LOG10`. Fix: rewriting is token-based and splices only the reference tokens.
7. **Styles lived in React state keyed by `"row,col"`.** They were not undoable, did not move on insert/delete, and toolbar formatting applied to one cell only. Fix: styles live in the engine (see data model).
8. **Bulk actions flooded undo.** `clearAllCells` called `setCell` 2,500 times and `loadSample` once per cell (30,000 entries for the large file), far beyond the 100-entry history, so none of it could be undone. Fix: transactions; each is one entry.
9. **Every render built all 2,500 cells** and evaluated each one; clicking a cell immediately entered edit mode and arrow keys committed edits. Fix: replaced by the virtualized grid and a select/edit keyboard model.

## Measurements

Machine: Intel Core i7-1185G7 (4 cores, 3.0 GHz), 16 GB, Windows 11, Node 22.20, Chrome 156 (headless, 1500×900). Engine numbers come from `npm run bench`: the same engine code the bundle ships, run in Node, median of 5. Browser numbers come from the production build (`npm run build && npm run preview`) driven by Puppeteer; commit counts come from `npm run build:profile`, which aliases React's profiling build. The status bar in the app shows `engine ms · ms to paint` for every action, so all of these can be reproduced by hand.

| Budget | Result | How |
|---|---|---|
| Fill 5,000 cells < 200 ms | **8.7 ms** (series), **19.2 ms** (formulas `=G2*H2`) | bench |
| Sort 10,000 rows < 300 ms, one undo step | **74.8 ms** (by Total, with a `=J/G` helper column, so formula rewriting is included) | bench; undo-step count in `sort.test.js` |
| Sort sales-large.tsv by Date | **10.7 ms** (Node); in the browser **15–46 ms** engine, 32–111 ms until the next frame is painted (3 clicks: asc, desc, original) | bench / status bar |
| First paint < 100 ms | grid first render (`performance.mark('grid-first-render')`) **median 65 ms** (52–101); first-contentful-paint **median 82 ms** (72–136, one of 12 over budget) over 12 warm navigations across three runs; the first, cold navigation of each fresh browser was 207–554 ms grid / 252–612 ms FCP | `performance.getEntriesByName` after each navigation |
| Scrolling at 60 fps | **16.7 ms average frame, p95 16.9 ms, max 17.1 ms** over 240 frames, scrolling 37 px/frame around row 90,000 with 100k formulas | rAF timestamps in the page |
| Keystroke latency < 16 ms with 50k+ filled cells | at J95000 with **130k filled cells**: keydown → React commit done **2.8–6.1 ms**; keydown → next frame **7–10 ms**; Event Timing processing ≤ 6.1 ms | capture/bubble listeners + `PerformanceObserver('event')` |
| No React state per cell; commit count | typing 5 characters = **5 commits, each touching only `cell-editor` + `formula-bar`** (≈ 0.06 ms each); the `Grid` component does not re-render while typing. Committing the edit = 3 grid commits, 2.8 ms render total | `<Profiler>` counters (`window.__commits`, `?debug`, profiling build) |
| Edits recalc only dependents | edit J2900 with 100k formulas in K: **0.002 ms** engine (J2900 + K2900 only) | bench |
| Fill K2 `=J2*2` to row 100,000 | **293 ms** (Node), **585 ms** (browser) | bench / status bar |
| Golden query plan over sales-large < 50 ms | slowest of the 20: **13.6 ms** | bench |
| Two-level group-by over 100,000 rows < 500 ms | **226 ms**, run in a Web Worker in the app so the panel stays responsive | bench |
| AI format on sales-large < 300 ms | **144–178 ms** in the browser (plan + canvas auto-fit of 30k cells + apply of 11,980 styles); 104 ms in Node with the width estimate | card note / bench |
| Insert a column with 100k live formulas (no budget) | 0.3–0.67 s (every formula is re-tokenized) | bench / status bar |

**How K2 = `=J2*2` was filled to row 100,000:** load *Sample 3k*, type `K2` in the name box and enter `=J2*2`, type `K2:K100000` in the name box, press **Ctrl+D**. The grid has 100,000 rows; `ensureCapacity` grows it when needed. The *⬇ 100k rows* button generates 100,000 rows shaped like sales-large.tsv for the group-by budget.

## AI

- **Provider.** `src/ai/provider.js` is the only file that knows the vendor. The `http` provider calls the Anthropic Messages API with plain `fetch` (default model `claude-opus-5-5`, `output_config.effort: "low"`, because translating a request into a small JSON plan is a light task). Endpoint, key and model come from `VITE_AI_*` in `.env.local`. Failures throw a `ProviderError` with a `kind` (`network`, `auth`, `rate_limit` with Retry-After, `server`, `bad_request`, `refusal`); the panel shows the code and message, and nothing in the sheet changes. Caveat: `VITE_*` values are bundled, so the key is visible in the browser. That is acceptable for a local demo, but a deployment should put a `server/` proxy in front, which I did not build.
- **Mock.** `mockProvider.js` is unchanged except that it matches on the `Request:` line of the user turn, because the user turn also carries the sheet context.
- **Exact context sent** (`buildContext`): headers, inferred type per column (`number | currency | percent | date | text | id`, from up to 200 values), three distinct examples per column, at most five sample rows, the data-row count (excluding blank rows and the totals row), the selection, and the totals flag. Never the full data. For sales.tsv with C2:C10 selected (sample rows cut to two here):

```json
{"range":"A1:J33","rowCount":30,"columns":[{"name":"Order ID","index":0,"type":"id","examples":["ORD-1001","ORD-1002","ORD-1003"]},{"name":"Date","index":1,"type":"date","examples":["2024-01-03","2024-01-05","1/8/2024"]},{"name":"Region","index":2,"type":"text","examples":["North","West","East"]},{"name":"Sales Rep","index":3,"type":"text","examples":["Aarav Shah","Priya Nair","Ben Carter"]},{"name":"Product","index":4,"type":"text","examples":["Laptop Pro","Desk Chair","Monitor 27\""]},{"name":"Category","index":5,"type":"text","examples":["Electronics","Furniture","Accessories"]},{"name":"Units","index":6,"type":"number","examples":["4","12","6"]},{"name":"Unit Price","index":7,"type":"currency","examples":["$1,200.00","$189.50","$320.00"]},{"name":"Discount","index":8,"type":"percent","examples":["10%","5%","15%"]},{"name":"Total","index":9,"type":"currency","examples":["$4,320.00","$2,160.30","$1,920.00"]}],"sampleRows":[["ORD-1001","2024-01-03","North","Aarav Shah","Laptop Pro","Electronics","4","$1,200.00","10%","$4,320.00"],["ORD-1002","2024-01-05","West","Priya Nair","Desk Chair","Furniture","12","$189.50","5%","$2,160.30"]],"selection":"C2:C10","hasTotalsRow":true}
```

  The user turn is `Sheet context:\n<that JSON>\n\nRequest: <prompt>`. The system prompt (`prompt.js`) carries the three schemas and the rules. History is the last six turns (prompt + raw reply).
- **Parsing and validation.** `extractJson` scans for balanced `{…}` (string- and escape-aware) and returns the first candidate that parses, so prose, ```` ```json ```` fences and stray braces before the object all work. `validateAction` is a hand-written JSON Schema subset (type incl. `integer` and unions, `const`, `enum`, `required`, `properties`, `additionalProperties: false`, `items`, `minimum`/`maximum`, `pattern`) that returns every failing path. Outcomes:
  - no JSON → `INVALID_RESPONSE`;
  - schema failure → `INVALID_RESPONSE` listing the paths (e.g. `$.filters[0].op must be one of …`);
  - a type other than query/format_sheet/clarify → `READ_ONLY`;
  - the executor rejects a non-query with `READ_ONLY` again, and returns `UNKNOWN_COLUMN` / `UNKNOWN_OP` / `UNKNOWN_FN` / `UNKNOWN_SORT_COLUMN`;
  - `UNKNOWN_COLUMN` is shown as a question listing the real columns, never a guess;
  - the limit is clamped to 500 in code.

  None of these touch the sheet.
- **Golden sets.** All 20 query cases and all 10 format cases pass through the mock (`src/ai/golden.test.js`), plus the large-sheet totals row at 2,992 and styles following insert with undo. Disagreements:
  - **f03 `J22` blank:** J22 is ORD-1020 (`$3,344.00`); the order with the blank Total is ORD-1021 in **J23**. Every other reference in the file (H7, I6, I14, H32) matches the fixture's numbering, so I treat it as an off-by-one in the golden file and check J23. The implementation is not special-cased.
  - **Widths outside 30..600:** §4.4 says to ignore them, but the schema (`minimum: 30, maximum: 600`) rejects them first, so such a response is `INVALID_RESPONSE`. The applier also ignores them in case the schema is relaxed.
  - **`freezeRows` equal to the used row count** is refused as `OUT_OF_RANGE` (≥, per §4.5).
- **Sort/filter choices.** Descending keeps the type groups in order (numbers, dates, text, then blanks) and reverses only within a group, as the spec lists "numbers before text, blanks last" without a direction. Fully empty rows, and rows that contain only formulas, always sort last. That puts the blank row of sales.tsv after ORD-1021 (blank Total) even after a helper column has been filled through it. A range reference moves on sort only when it lies within one row. Sorting a multi-row *selection* moves whole rows within those rows, so row identity, styles and heights stay consistent; Excel's "sort only the selected columns" mode is not offered.

## Trade-offs and what I would do next

- **Structural edits re-tokenize every affected formula** (0.3–0.7 s with 100k formulas). Next: store formulas in a relative (R1C1) form shared across a filled column, so insert/delete/sort rewrite only the text shown, and keep values on insert instead of recalculating.
- **Whole-column formatting writes one style per cell** (100k entries). Next: row and column style layers under the cell layer.
- **The query worker receives a structured clone of the table** (≈ 50–80 ms for 100k rows, once per sheet version). Next: columnar typed arrays transferred instead of cloned.
- **The formula language is small:** + − × ÷ ^, unary minus, strings, SUM / AVG / AVERAGE / MIN / MAX / COUNT / ABS / ROUND. There are no comparisons, IF or text functions.
- **Rendering gaps:** text doesn't spill into empty neighbours. Copy puts displayed text on the clipboard; paste writes values (formulas are not reference-shifted on paste).
- **Fill with three uneven date seeds** (B2:B4 = Jan 3, Jan 5, Jan 8) uses the linear trend rounded to whole days (≈ 2.5 days per step: Jan 11, 13, 16, 18). Two seeds use their exact delta.
- **The API key is exposed in the browser** in http mode; a `server/` proxy is the next step for anything shared.

## Use of AI tools

I used an AI coding assistant (Claude Code) during this work: to scaffold modules, write tests against the golden fixtures, draft these notes, and drive Chrome for the acceptance checks and measurements. I reviewed the design decisions recorded above (data model, remap/transaction undo, sticky-pane virtualization, executor semantics) and can walk through any of them.

## Reproducing the acceptance checks (recording script)

1. **Fill:** *Sample 33* → select A4:A6, Delete → select A2:A3, drag the ■ to A6 → Ctrl+Z. Type `=G2*H2` in K2 and `=$G$2*H2` in L2, select K2:L2, drag to row 32 → click C10, *+ Row* → L33 reads `=$G$2*H33`. Select B2:B4, drag to B8.
2. **Sort/filter:** *Sample 33*, `=J2/G2` in K2, drag to K32 → click a cell outside the table, J header ↕ twice → K2 = 1080, A33 = Total, the blank row is last. *Sample 33* → C header ▾ → untick all, tick West → Apply (`8 of 32 rows`) → G header ↕ → Ctrl+Z twice.
3. **Scale:** *Sample 3k* → name box `K2`, type `=J2*2` → name box `K2:K100000`, Ctrl+D → name box `J95000`, type a number (DevTools Performance / React Profiler recording; status bar shows timings) → *Freeze row 1*, drag the D header border to 300 px, select D5, *+ Col*.
4. **AI:** Ctrl+K, tick *show plan*, pick prompts from *Examples…* (the 20 query prompts on Sample 3k, the 10 format prompts on Sample 33), Apply/Discard, Re-run, Insert into sheet, Ctrl+Z.
