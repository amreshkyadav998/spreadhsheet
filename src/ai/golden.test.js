// Golden sets from fixtures/ai-eval, run end to end through the mock
// provider: prompt → raw text → parse → validate → execute / apply.
import { describe, it, expect } from 'vitest'
import { engineWith, readJson } from '../test/fixtures.js'
import { createMockProvider } from './mockProvider.js'
import { ask } from './assistant.js'
import { executeQuery } from './executor.js'
import { planFormat } from './formatApplier.js'
import { sheetTable } from './sheetData.js'
import { buildContext } from './context.js'
import { parseCellName } from '../engine/formula.js'

const queries = readJson('ai-eval/queries.json')
const formats = readJson('ai-eval/format-prompts.json')
const provider = createMockProvider()

function expectRowsClose(actual, expected) {
    expect(actual.length).toBe(expected.length)
    actual.forEach((row, i) => row.forEach((v, j) => {
        const e = expected[i][j]
        if (typeof e === 'number') expect(Math.abs(Number(v) - e)).toBeLessThanOrEqual(0.01)
        else expect(String(v)).toBe(String(e))
    }))
}

const sortRows = (rows) => [...rows].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)

describe('queries.json over sales-large.tsv', () => {
    const engine = engineWith('sales-large.tsv', 3100, 20)
    const table = sheetTable(engine)
    const context = buildContext(table, null)

    for (const c of queries.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const res = await ask({ provider, prompt: c.prompt, context })
            if (c.expect.error === 'READ_ONLY') {
                expect(res.ok).toBe(false)
                expect(res.error).toBe('READ_ONLY')
                return
            }
            expect(res.ok).toBe(true)
            expect(res.action).toEqual(c.plan)
            const result = executeQuery(res.action, table)
            if (c.expect.error) {
                expect(result).toEqual({ error: c.expect.error, detail: c.expect.detail })
                return
            }
            expect(result.columns).toEqual(c.expect.columns)
            expect(result.rowCount).toBe(c.expect.rowCount)
            expect(result.truncated).toBe(c.expect.truncated)
            if (c.expect.rows) {
                const ordered = !!(c.plan.sort && c.plan.sort.length)
                expectRowsClose(ordered ? result.rows : sortRows(result.rows), ordered ? c.expect.rows : sortRows(c.expect.rows))
            }
            if (c.expect.rowsPreview) expectRowsClose(result.rows.slice(0, c.expect.rowsPreview.length), c.expect.rowsPreview)
        })
    }

    it('the context never contains more than five sample rows', () => {
        expect(context.sampleRows.length).toBe(5)
        expect(context.rowCount).toBe(2986) // non-blank rows between header and totals
        expect(context.hasTotalsRow).toBe(true)
        expect(context.columns.map(c => c.type)).toEqual(['id', 'date', 'text', 'text', 'text', 'text', 'number', 'currency', 'percent', 'currency'])
    })
})

// f03 says J22 is blank, but J22 is ORD-1020 ($3,344.00); the order with the
// blank Total (ORD-1021) is J23. Every other reference in the set matches the
// fixture's row numbering, so we check the blank cell where it actually is.
const CELL_OVERRIDES = { 'f03:J22': 'J23' }

function check(engine, exp, outcome, undoBefore, id) {
    if (exp.cell) {
        const { row, col } = parseCellName(CELL_OVERRIDES[`${id}:${exp.cell}`] || exp.cell)
        if (exp.style) {
            const style = engine.getStyle(row, col)
            for (const [k, v] of Object.entries(exp.style)) expect(style[k], `${exp.cell}.${k}`).toBe(v)
        }
        if ('display' in exp) expect(engine.getDisplay(row, col), exp.cell).toBe(exp.display)
        if ('raw' in exp) expect(engine.getRaw(row, col), exp.cell).toBe(exp.raw)
    }
    if ('frozenRows' in exp) expect(engine.frozen.rows).toBe(exp.frozenRows)
    if ('undoSteps' in exp) expect(engine.undoDepth - undoBefore).toBe(exp.undoSteps)
    if (exp.result) expect(outcome.result).toBe(exp.result)
}

describe('format-prompts.json over sales.tsv', () => {
    for (const c of formats.cases) {
        it(`${c.id}: ${c.prompt}`, async () => {
            const engine = engineWith('sales.tsv')
            if (c.id === 'f04') engine.setFrozen({ rows: 1 })
            if (c.id === 'f06') engine.setStyle({ r1: 0, c1: 0, r2: 0, c2: 9 }, { bold: true, bg: '#f0f0f0' })
            if (c.id === 'f06') engine.setStyle({ r1: 1, c1: 7, r2: 32, c2: 7 }, { numberFormat: 'currency' })
            if (c.id === 'f10') engine.deleteRow(32)
            const res = await ask({ provider, prompt: c.prompt, context: buildContext(sheetTable(engine), null) })
            expect(res.ok).toBe(true)
            expect(res.action).toEqual(c.action)
            const undoBefore = engine.undoDepth
            const outcome = planFormat(res.action, engine)
            if (outcome.result === 'OK') expect(engine.applyFormatPatch(outcome.patch)).toBe(true)
            for (const exp of c.expect) check(engine, exp, outcome, undoBefore, c.id)
            if (outcome.result !== 'OK') expect(engine.undoDepth).toBe(undoBefore)
            if (outcome.result === 'OK') {
                engine.undo()
                expect(engine.undoDepth).toBe(undoBefore)
            }
        })
    }

    it('f04 without a prior freeze is NO_CHANGES', () => {
        const engine = engineWith('sales.tsv')
        expect(planFormat({ type: 'format_sheet', freezeRows: 0 }, engine).result).toBe('NO_CHANGES')
    })

    it('f01 on sales-large.tsv styles the totals row at 2,992', () => {
        const engine = engineWith('sales-large.tsv', 3100, 20)
        const outcome = planFormat(formats.cases[0].action, engine)
        engine.applyFormatPatch(outcome.patch)
        expect(outcome.totalsRow).toBe(2991)
        expect(engine.getStyle(2991, 0).bold).toBe(true)
        expect(engine.getStyle(2990, 0).bold).toBe(false)
        expect(engine.getDisplay(1, 8)).toBe('5%')
    })

    it('styles follow insert/delete rows with undo', () => {
        const engine = engineWith('sales.tsv')
        engine.applyFormatPatch(planFormat(formats.cases[0].action, engine).patch)
        engine.insertRow(0)
        expect(engine.getStyle(1, 0).bold).toBe(true)
        expect(engine.getDisplay(2, 7)).toBe('$1,200.00')
        engine.undo()
        expect(engine.getStyle(0, 0).bold).toBe(true)
    })
})
