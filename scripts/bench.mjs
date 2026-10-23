// Engine benchmarks: `npm run bench`. Runs the same engine code the
// production bundle ships, in Node, and prints the median of N runs.
// Browser-side numbers (paint, scroll, keystroke) are measured in the
// app itself; see DESIGN_NOTES.md → Measurements.
import { readFileSync } from 'node:fs'
import { createEngine } from '../src/engine/core.js'
import { loadTsv, loadRows, generateRows } from '../src/fixtures/tsv.js'
import { executeQuery } from '../src/ai/executor.js'
import { planFormat } from '../src/ai/formatApplier.js'
import { sheetTable } from '../src/ai/sheetData.js'

const RUNS = Number(process.env.RUNS || 5)
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const SMALL = fixture('sales.tsv')
const LARGE = fixture('sales-large.tsv')
const QUERIES = JSON.parse(fixture('ai-eval/queries.json'))

function median(xs) {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
}

function bench(name, budget, setup, run) {
    const times = []
    for (let i = 0; i < RUNS; i++) {
        const ctx = setup()
        const t0 = performance.now()
        run(ctx)
        times.push(performance.now() - t0)
    }
    const m = median(times)
    const verdict = budget ? (m < budget ? 'ok' : 'OVER') : ''
    console.log(`${name.padEnd(58)} ${m.toFixed(m < 1 ? 3 : 1).padStart(8)} ms  ${budget ? `(budget ${budget} ms) ${verdict}` : ''}`)
}

function largeSheet(rows = 100000) {
    const e = createEngine(rows, 200)
    loadTsv(e, LARGE)
    return e
}

function generatedSheet(n) {
    const e = createEngine(n + 50, 30)
    loadRows(e, generateRows(LARGE, n))
    return e
}

bench('fill 5,000 cells (A2:A3 series dragged to A5001)', 200,
    () => {
        const e = createEngine(10000, 10)
        e.setCell(1, 0, 'Item 1')
        e.setCell(2, 0, 'Item 2')
        return e
    },
    (e) => e.fill({ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5000, c2: 0 }))

bench('fill 5,000 formulas (=G2*H2 down)', 200,
    () => {
        const e = createEngine(10000, 20)
        loadTsv(e, SMALL)
        e.setCell(1, 10, '=G2*H2')
        return e
    },
    (e) => e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 5000, c2: 10 }))

bench('sort 10,000 rows by Total (with =J/G helper column)', 300,
    () => {
        const e = generatedSheet(10000)
        e.setCell(1, 10, '=J2/G2')
        e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 10000, c2: 10 }, { copy: true })
        return e
    },
    (e) => e.cycleSort(9))

bench('sort sales-large.tsv by Date', 300, () => largeSheet(5000), (e) => e.cycleSort(1))

bench('fill K2 = =J2*2 down to row 100,000 (Ctrl+D)', null,
    () => {
        const e = largeSheet()
        e.setCell(1, 10, '=J2*2')
        return e
    },
    (e) => e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 99999, c2: 10 }, { copy: true }))

{
    const e = largeSheet()
    e.setCell(1, 10, '=J2*2')
    e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 99999, c2: 10 }, { copy: true })
    let n = 0
    bench('commit an edit to J2900 with 100k formulas (dependents only)', 16,
        () => e,
        (eng) => eng.setCell(2899, 9, String(1000 + n++)))
    bench('insert a column before D with 100k formulas', null, () => e, (eng) => eng.insertColumn(3))
    bench('undo that insert', null, () => e, (eng) => eng.undo())
}

{
    const e = largeSheet(5000)
    const table = sheetTable(e)
    const plans = QUERIES.cases.map(c => c.plan)
    let worst = 0
    for (const plan of plans) {
        const times = []
        for (let i = 0; i < RUNS; i++) {
            const t0 = performance.now()
            executeQuery(plan, table)
            times.push(performance.now() - t0)
        }
        worst = Math.max(worst, median(times))
    }
    console.log(`${'slowest golden query plan over sales-large.tsv'.padEnd(58)} ${worst.toFixed(1).padStart(8)} ms  (budget 50 ms) ${worst < 50 ? 'ok' : 'OVER'}`)
    bench('extract sheet table for the executor (sales-large.tsv)', null, () => e, (eng) => sheetTable(eng))
}

bench('two-level group-by over 100,000 generated rows', 500,
    () => sheetTable(generatedSheet(100000)),
    (table) => executeQuery({
        type: 'query',
        groupBy: ['Region', 'Category'],
        aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }, { fn: 'avg', column: 'Discount' }],
        sort: [{ column: 'Region' }, { column: 'Sales', dir: 'desc' }],
    }, table))

bench('format "clean table" on sales-large.tsv (plan + apply)', 300,
    () => largeSheet(5000),
    (e) => {
        const plan = planFormat({
            type: 'format_sheet',
            headerStyle: { bold: true, bg: '#f0f0f0', align: 'center' },
            columns: [6, 7, 8, 9].map(col => ({ col, style: { align: 'right', numberFormat: col === 8 ? 'percent' : 'currency' } })),
            totalsStyle: { bold: true },
            freezeRows: 1,
            autoFitColumns: true,
        }, e)
        e.applyFormatPatch(plan.patch)
    })
