import { describe, it, expect } from 'vitest'
import { createAxis } from './layout.js'

describe('axis layout', () => {
    it('prefix sums with overrides and hidden entries', () => {
        const axis = createAxis(10, 24, new Map([[2, 50]]), new Set([4]))
        expect(axis.offsetOf(3)).toBe(24 + 24 + 50)
        expect(axis.sizeOf(4)).toBe(0)
        expect(axis.offsetOf(5)).toBe(axis.offsetOf(4))
        expect(axis.total).toBe(8 * 24 + 50)
    })

    it('binary-searches a pixel to an index and skips hidden rows', () => {
        const axis = createAxis(10, 24, new Map([[2, 50]]), new Set([4]))
        expect(axis.indexAt(0)).toBe(0)
        expect(axis.indexAt(47)).toBe(1)
        expect(axis.indexAt(48)).toBe(2)
        expect(axis.indexAt(97)).toBe(2)
        expect(axis.indexAt(98)).toBe(3)
        expect(axis.indexAt(122)).toBe(5) // row 4 is hidden
        expect(axis.indexAt(1e9)).toBe(9)
        expect(axis.step(3, 1)).toBe(5)
        expect(axis.step(5, -1)).toBe(3)
        expect(axis.step(9, 1)).toBe(9)
    })

    it('handles 100,000 rows quickly', () => {
        const t0 = performance.now()
        const axis = createAxis(100000, 24, new Map(), new Set())
        expect(axis.indexAt(95000 * 24 + 5)).toBe(95000)
        expect(performance.now() - t0).toBeLessThan(50)
    })
})
