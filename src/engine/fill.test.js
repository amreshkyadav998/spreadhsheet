import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { analyzeSeeds } from './fill.js'
import { engineWith } from '../test/fixtures.js'

const series = (seeds, ks) => {
    const gen = analyzeSeeds(seeds)
    return ks.map(gen)
}

describe('series detection', () => {
    it('copies one number and continues two', () => {
        expect(series(['5'], [1, 2])).toEqual(['5', '5'])
        expect(series(['1', '2'], [2, 3])).toEqual(['3', '4'])
        expect(series(['0.1', '0.2'], [2])).toEqual(['0.3'])
        expect(series(['10', '8'], [2, -1])).toEqual(['6', '12'])
    })

    it('increments text ending in a number and keeps zero padding', () => {
        expect(series(['Item 1'], [1, 2])).toEqual(['Item 2', 'Item 3'])
        expect(series(['Q4'], [1])).toEqual(['Q5'])
        expect(series(['2024-W01'], [1, 9])).toEqual(['2024-W02', '2024-W10'])
        expect(series(['ORD-1001', 'ORD-1002'], [2, 3, 4])).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
    })

    it('steps dates by the seed delta and keeps each seed format', () => {
        expect(series(['2024-01-15'], [1])).toEqual(['2024-01-16'])
        expect(series(['1/15/2024', '1/22/2024'], [2])).toEqual(['1/29/2024'])
        expect(series(['2024-01-30', '15 Feb 2024'], [2, 3])).toEqual(['2024-03-02', '18 Mar 2024'])
        expect(series(['2024-01-31'], [1])).toEqual(['2024-02-01'])
    })

    it('cycles weekday and month names preserving case', () => {
        expect(series(['Mon'], [1, 6, 7])).toEqual(['Tue', 'Sun', 'Mon'])
        expect(series(['JANUARY'], [1])).toEqual(['FEBRUARY'])
        expect(series(['dec'], [1])).toEqual(['jan'])
        expect(series(['Mon', 'Wed'], [2])).toEqual(['Fri'])
    })

    it('repeats anything else', () => {
        expect(series(['a', 'b'], [2, 3, 4])).toEqual(['a', 'b', 'a'])
    })
})

describe('fill handle on sales.tsv', () => {
    it('A2:A3 dragged to A6 continues the order ids, one undo restores', () => {
        const e = engineWith('sales.tsv')
        // the fixture already holds ORD-1003..1005 there; clear them so the fill is visible
        e.clearContents({ r1: 3, c1: 0, r2: 5, c2: 0 })
        const before = [3, 4, 5].map(r => e.getRaw(r, 0))
        e.fill({ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5, c2: 0 })
        expect([3, 4, 5].map(r => e.getRaw(r, 0))).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        e.undo()
        expect([3, 4, 5].map(r => e.getRaw(r, 0))).toEqual(before)
    })

    it('fills relative and absolute formulas, then follows an inserted row', () => {
        const e = engineWith('sales.tsv')
        e.setCell(1, 10, '=G2*H2')
        e.setCell(1, 11, '=$G$2*H2')
        e.fill({ r1: 1, c1: 10, r2: 1, c2: 11 }, { r1: 1, c1: 10, r2: 31, c2: 11 })
        expect(e.getRaw(31, 10)).toBe('=G32*H32')
        expect(e.getRaw(31, 11)).toBe('=$G$2*H32')
        expect(e.getCell(1, 10).computed).toBe(4800)
        e.insertRow(9)
        expect(e.getRaw(32, 11)).toBe('=$G$2*H33')
    })

    it('B2:B4 filled to B8 keeps each seed date format', () => {
        const e = engineWith('sales.tsv')
        e.fill({ r1: 1, c1: 1, r2: 3, c2: 1 }, { r1: 1, c1: 1, r2: 7, c2: 1 })
        const out = [4, 5, 6, 7].map(r => e.getRaw(r, 1))
        expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(out[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(out[2]).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/)
        expect(out[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('filled cells inherit the seed style; dragging back shrinks', () => {
        const e = createEngine(20, 5)
        e.setCell(0, 0, '1')
        e.setCell(1, 0, '2')
        e.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true })
        e.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5, c2: 0 })
        expect(e.getRaw(5, 0)).toBe('6')
        expect(e.getStyle(4, 0).bold).toBe(true)
        expect(e.getStyle(5, 0).bold).toBe(false)
        e.fill({ r1: 0, c1: 0, r2: 5, c2: 0 }, { r1: 0, c1: 0, r2: 2, c2: 0 })
        expect(e.getRaw(3, 0)).toBe('')
        expect(e.getRaw(2, 0)).toBe('3')
    })

    it('fills up and left', () => {
        const e = createEngine(20, 20)
        e.setCell(10, 10, 'Mon')
        e.fill({ r1: 10, c1: 10, r2: 10, c2: 10 }, { r1: 8, c1: 10, r2: 10, c2: 10 })
        expect(e.getRaw(9, 10)).toBe('Sun')
        e.setCell(5, 5, '=A1')
        e.fill({ r1: 5, c1: 5, r2: 5, c2: 5 }, { r1: 5, c1: 4, r2: 5, c2: 5 })
        expect(e.getRaw(5, 4)).toBe('=#REF!')
    })
})
