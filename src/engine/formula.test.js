import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { shiftFormula, parseRangeName, rewriteRefs } from './formula.js'
import { toNum, toDate } from './values.js'

describe('formulas', () => {
    it('handles precedence, unary minus and powers', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '=2+3*4')
        e.setCell(0, 1, '=-(2+3)^2')
        e.setCell(0, 2, '=10/4-1')
        expect(e.getCell(0, 0).computed).toBe(14)
        expect(e.getCell(0, 1).computed).toBe(25) // unary minus binds tighter than ^, as in Excel
        expect(e.getCell(0, 2).computed).toBe(1.5)
    })

    it('coerces messy text in arithmetic and ranges', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '$1,200.00')
        e.setCell(1, 0, '4')
        e.setCell(2, 0, 'N/A')
        e.setCell(0, 1, '=A1*A2')
        e.setCell(1, 1, '=SUM(A1:A3)')
        e.setCell(2, 1, '=A3*2')
        expect(e.getCell(0, 1).computed).toBe(4800)
        expect(e.getCell(1, 1).computed).toBe(1204)
        expect(e.getCell(2, 1).error).toBe('#VALUE!')
    })

    it('keeps dates and percentages as text values', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '2024-01-03')
        e.setCell(0, 1, '10%')
        expect(e.getCell(0, 0).computed).toBe('2024-01-03')
        expect(e.getCell(0, 1).computed).toBe('10%')
        expect(e.getDisplay(0, 0)).toBe('2024-01-03')
    })

    it('recalculates a range formula when an interior cell changes', () => {
        const e = createEngine(10, 10)
        for (let r = 0; r < 5; r++) e.setCell(r, 0, String(r + 1))
        e.setCell(5, 0, '=SUM(A1:A5)')
        expect(e.getCell(5, 0).computed).toBe(15)
        e.setCell(2, 0, '100')
        expect(e.getCell(5, 0).computed).toBe(112)
    })

    it('reports errors', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '=1/0')
        e.setCell(0, 1, '=FOO(A1:A2)')
        e.setCell(0, 2, '=1+')
        e.setCell(0, 3, '=A1+1')
        expect(e.getCell(0, 0).error).toBe('#DIV/0!')
        expect(e.getCell(0, 1).error).toBe('#NAME?')
        expect(e.getCell(0, 2).error).toBe('#PARSE!')
        expect(e.getCell(0, 3).error).toBe('#DIV/0!')
    })

    it('detects a cycle through a range and recovers when it is broken', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '=SUM(A2:A3)')
        e.setCell(1, 0, '=A1')
        expect(e.getCell(0, 0).error).toBe('#CYCLE!')
        expect(e.getCell(1, 0).error).toBe('#CYCLE!')
        e.setCell(1, 0, '5')
        expect(e.getCell(0, 0).computed).toBe(5)
    })

    it('handles a 20,000-deep dependency chain without recursion', () => {
        const e = createEngine(20001, 2)
        e.setCell(0, 0, '1')
        const updates = []
        for (let r = 1; r < 20000; r++) updates.push({ row: r, col: 0, raw: `=A${r}+1` })
        e.setCells(updates)
        expect(e.getCell(19999, 0).computed).toBe(20000)
        e.setCell(0, 0, '10')
        expect(e.getCell(19999, 0).computed).toBe(20009)
    })

    it('shifts relative references and pins absolute ones', () => {
        expect(shiftFormula('=G2*H2', 30, 0)).toBe('=G32*H32')
        expect(shiftFormula('=$G$2*H2', 30, 0)).toBe('=$G$2*H32')
        expect(shiftFormula('=$A1+A$1+SUM(B1:B3)', 2, 1)).toBe('=$A3+B$1+SUM(C3:C5)')
        expect(shiftFormula('=A1', -1, 0)).toBe('=#REF!')
        expect(rewriteRefs('=a1 + 1', { cell: (r) => r, range: (a, b) => [a, b] })).toBe('=a1 + 1')
    })

    it('parses addresses', () => {
        expect(parseRangeName('AZ5000')).toEqual({ r1: 4999, c1: 51, r2: 4999, c2: 51 })
        expect(parseRangeName('c5:a1')).toEqual({ r1: 0, c1: 0, r2: 4, c2: 2 })
        expect(parseRangeName('nope')).toBeNull()
    })
})

describe('value coercion', () => {
    it('follows the contract rules', () => {
        expect(toNum('$1,200.00')).toBe(1200)
        expect(toNum('10%')).toBe(0.1)
        expect(toNum('15 %')).toBe(0.15)
        expect(toNum('$ 49.99')).toBe(49.99)
        expect(toNum('N/A')).toBeNull()
        expect(toNum('')).toBeNull()
        expect(toDate('1/8/2024')).toBe('2024-01-08')
        expect(toDate('15 Jan 2024')).toBe('2024-01-15')
        expect(toDate('2024-2-30')).toBeNull()
    })
})
