# SpreadsheetApp

A small browser spreadsheet built with React and Vite: a sparse cell engine with formulas, dependency tracking and undo, and a single-file grid UI.

**Candidates: the tasks are in [`CHALLENGE.md`](./CHALLENGE.md).** The AI tasks are specified in [`AI_CONTRACT.md`](./AI_CONTRACT.md). Write up your work in [`DESIGN_NOTES.md`](./DESIGN_NOTES.md).

## Prerequisites

- Node.js 18 or newer
- npm
- Git

## Getting started

```bash
git clone https://github.com/tauhidst07/spreadhsheet.git
cd spreadhsheet
npm install
npm run dev
```

Open `http://localhost:5173`. The toolbar has two sample loaders: **⬇ Sample 33** loads `fixtures/sales.tsv` (33 rows) and **⬇ Sample 3k** loads `fixtures/sales-large.tsv` (about 3,000 rows) at `A1`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run build:profile` | Production build with React's profiling build (React DevTools profiler / commit counts) |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint |
| `npm test` | Run the Vitest suite once (`npm run test:watch` to keep it running); includes both AI golden sets |
| `npm run bench` | Engine, executor and format benchmarks against the challenge budgets |

For the AI tasks, copy `.env.example` to `.env.local` and set `VITE_AI_PROVIDER=http` and `VITE_AI_API_KEY` (Anthropic Messages API; endpoint and model have defaults). The default provider is an offline mock, so the app runs without any key. There is no backend.

Add `?debug` to the URL to expose the engine as `window.__engine` and React commit counters as `window.__commits`.

## Project structure

```
spreadhsheet/
├── src/
│   ├── engine/                # Pure spreadsheet logic, no React
│   │   ├── core.js            # State, transactions/undo, recalc, insert/delete, sort, filter state
│   │   ├── formula.js         # Addresses, tokenizer, parser, evaluator, reference rewriting
│   │   ├── values.js          # toNum / toDate / norm: one reading of messy cells for everything
│   │   ├── fill.js            # Fill-handle series detection
│   │   ├── sort.js, filter.js # Sort ordering, filter predicates
│   │   ├── format.js          # Style defaults, number formats (display only)
│   │   └── *.test.js
│   ├── ai/                    # Pure AI pipeline, no React
│   │   ├── contract.js        # The JSON actions a model may return, with schemas
│   │   ├── provider.js        # Provider interface; mock + Anthropic http provider (only vendor-aware file)
│   │   ├── mockProvider.js    # Offline provider that answers the prompts in fixtures/ai-eval
│   │   ├── assistant.js       # prompt → provider → parse → validate
│   │   ├── parse.js, validate.js, prompt.js, context.js, describe.js
│   │   ├── executor.js        # Query executor (AI_CONTRACT.md §3)
│   │   ├── formatApplier.js   # format_sheet planner (AI_CONTRACT.md §4)
│   │   └── queryRunner.js, query.worker.js  # big queries off the main thread
│   ├── ui/                    # React: Grid (virtualized), FilterMenu, AiPanel, FormulaBar, layout
│   ├── fixtures/              # Sample loaders (lazy) and TSV import
│   ├── App.jsx                # Shell: toolbar, name box, keyboard model, status bar
│   └── App.css
├── scripts/bench.mjs          # npm run bench
├── fixtures/                  # sales.tsv, sales-large.tsv, ai-eval golden sets
├── CHALLENGE.md, AI_CONTRACT.md
└── DESIGN_NOTES.md            # Design, engine API, undo semantics, measurements
```

## What works

- 100,000 × 200 virtualized grid with frozen rows/columns, column resize/auto-fit, row resize, name box (`AZ5000`, `K2:K100000`), formula bar.
- Selection: click, drag, Shift+Click, Shift+Arrow, row/column headers, Ctrl+A. Editing: double-click, Enter, F2 or just type. Delete clears the selection.
- Fill handle (series, dates, weekday/month names, formulas with `$` references), Ctrl+D / Ctrl+R.
- Sort (header ↕: ascending → descending → original) and filters (header ▾), formulas follow sorted rows.
- Formulas: `+ - * / ^`, unary minus, `SUM AVG AVERAGE MIN MAX COUNT ABS ROUND`, `$A$1` references, `#REF!`, `#DIV/0!`, `#CYCLE!`, `#NAME?`, `#PARSE!`.
- Every action is one undo step (Ctrl+Z / Ctrl+Y), including insert/delete, sort, filters, fill, paste and AI actions.
- Ctrl+K assistant: ask questions (executed locally over the sheet) or format the sheet, with plans shown on demand.

Keyboard: arrows, Shift+arrows, Ctrl+arrows, Home, Ctrl+Home/End, PageUp/PageDown, Tab, Enter, F2, Esc, Delete, Ctrl+Z/Y, Ctrl+B/I/U, Ctrl+D/R, Ctrl+C/V, Ctrl+K.

## Browser support

Current Chrome, Firefox, Safari and Edge.

## Troubleshooting

- **Install fails:** `rm -rf node_modules package-lock.json && npm install`.
- **Port 5173 busy:** Vite picks the next free port, or run `npm run dev -- --port 3000`.
- **Build fails:** make sure `npm install` completed, then `rm -rf dist && npm run build`.
