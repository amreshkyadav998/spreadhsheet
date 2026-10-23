// Graders run `npm test` and add hidden tests against the public engine
// API documented in DESIGN_NOTES.md.
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })
})

describe('structure', () => {
    it('turns references to a deleted row into #REF! and shrinks ranges', () => {
        const e = createEngine(20, 5)
        for (let r = 0; r < 5; r++) e.setCell(r, 0, String(r + 1))
        e.setCell(10, 0, '=A3*2')
        e.setCell(11, 0, '=SUM(A1:A5)')
        e.deleteRow(2)
        expect(e.getCell(9, 0).raw).toBe('=#REF!*2')
        expect(e.getCell(9, 0).error).toBe('#REF!')
        expect(e.getCell(10, 0).raw).toBe('=SUM(A1:A4)')
        expect(e.getCell(10, 0).computed).toBe(12)
        e.undo()
        expect(e.getCell(10, 0).raw).toBe('=A3*2')
        expect(e.getCell(11, 0).raw).toBe('=SUM(A1:A5)')
        expect(e.getCell(2, 0).raw).toBe('3')
        expect(e.getCell(11, 0).computed).toBe(15)
        e.redo()
        expect(e.getCell(10, 0).raw).toBe('=SUM(A1:A4)')
    })

    it('moves styles and sizes with inserted and deleted columns', () => {
        const e = createEngine(10, 10)
        e.setColWidth(3, 300)
        e.setStyle({ r1: 0, c1: 3, r2: 0, c2: 3 }, { bold: true })
        e.insertColumn(3)
        expect(e.getColWidth(3)).toBe(100)
        expect(e.getColWidth(4)).toBe(300)
        expect(e.getStyle(0, 4).bold).toBe(true)
        expect(e.getStyle(0, 3).bold).toBe(false)
        e.undo()
        expect(e.getColWidth(3)).toBe(300)
        e.deleteColumn(3)
        expect(e.getColWidth(3)).toBe(100)
        e.undo()
        expect(e.getColWidth(3)).toBe(300)
        expect(e.getStyle(0, 3).bold).toBe(true)
    })

    it('rolls back a failed transaction', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, 'keep')
        expect(() => e.batch('boom', () => { e.setCell(0, 0, 'lost'); throw new Error('x') })).toThrow()
        expect(e.getCell(0, 0).raw).toBe('keep')
        expect(e.undoDepth).toBe(1)
    })
})

describe('selection edits', () => {
    it('clears a range and formats a range as one undo step each', () => {
        const e = createEngine(10, 10)
        e.setCells([{ row: 0, col: 0, raw: 'a' }, { row: 1, col: 1, raw: 'b' }])
        const depth = e.undoDepth
        e.clearContents({ r1: 0, c1: 0, r2: 5, c2: 5 })
        expect(e.getRaw(1, 1)).toBe('')
        e.setStyle({ r1: 0, c1: 0, r2: 2, c2: 2 }, { bold: true })
        expect(e.undoDepth).toBe(depth + 2)
        e.undo()
        e.undo()
        expect(e.getRaw(1, 1)).toBe('b')
    })
})
