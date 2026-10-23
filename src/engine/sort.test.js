import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { engineWith } from '../test/fixtures.js'

const TOTAL = 9, UNITS = 6, REGION = 2

function column(e, col, r1 = 1, r2 = 32) {
    const out = []
    for (let r = r1; r <= r2; r++) out.push(e.getRaw(r, col))
    return out
}

describe('sort on sales.tsv', () => {
    it('formulas follow their rows; totals row stays pinned; blank row last', () => {
        const e = engineWith('sales.tsv')
        e.setCell(1, 10, '=J2/G2')
        e.fill({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 31, c2: 10 })
        e.setCell(0, 12, '=SUM(J2:J32)') // M1, in the header row so it is outside the block
        const sumBefore = e.getCell(0, 12).computed

        expect(e.cycleSort(TOTAL)).toBe('asc')
        expect(e.cycleSort(TOTAL)).toBe('desc')
        expect(e.getRaw(1, 0)).toBe('ORD-1025')
        expect(e.getCell(1, 10).computed).toBe(1080)
        expect(e.getRaw(32, 0)).toBe('Total')
        // the fully blank row sorts last, after the order with a blank Total
        expect(e.getRaw(31, 0)).toBe('')
        expect(e.getRaw(30, 0)).toBe('ORD-1021')
        expect(e.getRaw(0, 12)).toBe('=SUM(J2:J32)')
        expect(e.getCell(0, 12).computed).toBe(sumBefore)
        // every K formula still divides its own row
        for (let r = 1; r <= 31; r++) {
            const raw = e.getRaw(r, 10)
            if (raw) expect(raw).toBe(`=J${r + 1}/G${r + 1}`)
        }
    })

    it('ascending → descending → original order', () => {
        const e = engineWith('sales.tsv')
        const original = column(e, 0)
        e.cycleSort(UNITS)
        e.cycleSort(UNITS)
        expect(e.cycleSort(UNITS)).toBe('original')
        expect(column(e, 0)).toEqual(original)
    })

    it('with a filter, only visible rows move; two undos restore everything', () => {
        const e = engineWith('sales.tsv')
        const original = column(e, 0)
        e.setFilter(REGION, { values: ['west'], cond: null })
        const hidden = e.getHiddenRows()
        expect(e.getFilterStatus()).toEqual({ total: 32, visible: 8, active: true })
        const hiddenBefore = [...hidden].map(r => [r, e.getRaw(r, 0)])

        e.cycleSort(UNITS)
        for (const [r, id] of hiddenBefore) expect(e.getRaw(r, 0)).toBe(id)
        const visibleUnits = []
        for (let r = 1; r <= 32; r++) if (!e.getHiddenRows().has(r)) visibleUnits.push(Number(e.getRaw(r, UNITS)))
        expect(visibleUnits).toEqual([...visibleUnits].sort((a, b) => a - b))

        e.undo()
        e.undo()
        expect(column(e, 0)).toEqual(original)
        expect(e.getFilterStatus().active).toBe(false)
    })

    it('one undo step per sort and styles move with rows', () => {
        const e = engineWith('sales.tsv')
        e.setStyle({ r1: 26, c1: 0, r2: 26, c2: 9 }, { bg: '#ffff99' }) // ORD-1025 row
        const depth = e.undoDepth
        e.cycleSort(TOTAL)
        e.cycleSort(TOTAL)
        expect(e.undoDepth).toBe(depth + 2)
        expect(e.getStyle(1, 0).bg).toBe('#ffff99')
        e.undo()
        e.undo()
        expect(e.getStyle(26, 0).bg).toBe('#ffff99')
    })
})

describe('comparison rules', () => {
    it('numbers before text, blanks last, dates as dates, case-insensitive, stable', () => {
        const e = createEngine(20, 3)
        const values = ['banana', '10', '', '2', 'Apple', '15 Jan 2024', '2024-01-02', 'apple']
        e.setCells([{ row: 0, col: 0, raw: 'H' }, ...values.map((raw, i) => ({ row: i + 1, col: 0, raw })), ...values.map((_, i) => ({ row: i + 1, col: 1, raw: String(i) }))])
        e.sortRows({ r1: 1, r2: 8, c1: 0, c2: 1 }, 0, 'asc')
        expect(column(e, 0, 1, 8)).toEqual(['2', '10', '2024-01-02', '15 Jan 2024', 'Apple', 'apple', 'banana', ''])
        e.sortRows({ r1: 1, r2: 8, c1: 0, c2: 1 }, 0, 'desc')
        expect(column(e, 0, 1, 8)).toEqual(['10', '2', '15 Jan 2024', '2024-01-02', 'banana', 'Apple', 'apple', ''])
    })
})
