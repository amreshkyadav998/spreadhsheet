// ─────────────────────────────────────────────────────────────
//  Axis layout for the virtualized grid: prefix sums of row heights
//  or column widths, binary search from a pixel offset to an index.
//  Hidden (filtered) rows have size 0. Pure, no React.
// ─────────────────────────────────────────────────────────────

/**
 * @param {number} count
 * @param {number} defaultSize
 * @param {Map<number, number>} overrides  index → size
 * @param {Set<number>} [hidden]           indexes with size 0
 */
export function createAxis(count, defaultSize, overrides, hidden) {
    const offsets = new Float64Array(count + 1)
    let acc = 0
    for (let i = 0; i < count; i++) {
        offsets[i] = acc
        if (hidden && hidden.has(i)) continue
        const o = overrides.get(i)
        acc += o === undefined ? defaultSize : o
    }
    offsets[count] = acc

    /** Index whose span contains px (clamped). Zero-size entries are skipped. */
    function indexAt(px) {
        if (px <= 0) return firstVisible(0, 1)
        if (px >= acc) return lastVisible()
        let lo = 0, hi = count - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (offsets[mid] <= px) lo = mid
            else hi = mid - 1
        }
        // offsets[lo] <= px; walk past zero-size entries that share the offset
        while (lo < count - 1 && offsets[lo + 1] <= px) lo++
        return lo
    }

    const sizeOf = (i) => offsets[i + 1] - offsets[i]

    function firstVisible(from, step) {
        for (let i = from; i >= 0 && i < count; i += step) if (sizeOf(i) > 0) return i
        return Math.max(0, Math.min(count - 1, from))
    }

    function lastVisible() {
        return firstVisible(count - 1, -1)
    }

    /** Next index in direction step (±1) with non-zero size, or `from` if none. */
    function step(from, delta) {
        const dir = delta < 0 ? -1 : 1
        let i = from
        let moved = 0
        while (moved < Math.abs(delta)) {
            let j = i + dir
            while (j >= 0 && j < count && sizeOf(j) === 0) j += dir
            if (j < 0 || j >= count) break
            i = j
            moved++
        }
        return i
    }

    return {
        count,
        total: acc,
        offsetOf: (i) => offsets[Math.max(0, Math.min(count, i))],
        sizeOf,
        indexAt,
        step,
        firstVisible: () => firstVisible(0, 1),
        lastVisible,
    }
}
