// ─────────────────────────────────────────────────────────────
//  Fill handle: series detection and generation. Pure.
//
//  A "line" is one column (vertical fill) or one row (horizontal
//  fill) of seed cells. Each line is analysed on its own and then
//  extended to any offset k, where k = 0 is the first seed; k < 0
//  means filling up / left.
// ─────────────────────────────────────────────────────────────

import { shiftFormula } from './formula.js'
import { isPlainNumber, parseDateParts, dateToSerial, serialToDateText, matchCase } from './values.js'

const NAME_LISTS = [
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
]

const TEXT_NUMBER = /^(.*\D)(\d+)$/

const mod = (a, n) => ((a % n) + n) % n

function roundNoise(n) {
    return parseFloat(n.toPrecision(12))
}

/** Step of a linear sequence, or null when the seeds are not evenly spaced. */
function linearStep(values) {
    if (values.length === 1) return null
    const step = (values[values.length - 1] - values[0]) / (values.length - 1)
    for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - values[i - 1] - step) > 1e-9 * Math.max(1, Math.abs(step))) return null
    }
    return step
}

/**
 * Analyse one line of seed raws.
 * @returns {(k:number) => string}  generator for the raw at offset k
 */
export function analyzeSeeds(seeds) {
    const n = seeds.length
    const cycle = (k) => seeds[mod(k, n)]
    if (n === 0) return () => ''
    if (seeds.some(s => typeof s === 'string' && s.startsWith('='))) {
        return (k) => {
            const i = mod(k, n)
            const seed = seeds[i]
            return seed.startsWith('=') ? shiftFormula(seed, k - i, 0) : seed
        }
    }
    if (seeds.some(s => s === '')) return cycle

    // Plain numbers: one seed copies; two or more continue the trend.
    if (seeds.every(isPlainNumber)) {
        const nums = seeds.map(Number)
        const step = n === 1 ? 0 : (nums[n - 1] - nums[0]) / (n - 1)
        if (n === 1) return cycle
        return (k) => String(roundNoise(nums[0] + step * k))
    }

    // Dates: step by the seed delta in days, each output keeps the
    // format of the seed it corresponds to in the repeating pattern.
    const dates = seeds.map(parseDateParts)
    if (dates.every(Boolean)) {
        const serials = dates.map(dateToSerial)
        const step = n === 1 ? 1 : (serials[n - 1] - serials[0]) / (n - 1)
        return (k) => serialToDateText(Math.round(serials[0] + step * k), dates[mod(k, n)])
    }

    // Weekday / month names cycle and keep the seed's case.
    for (const list of NAME_LISTS) {
        const idx = seeds.map(s => list.indexOf(s.trim().toLowerCase()))
        if (idx.every(i => i >= 0)) {
            let step = 1
            if (n > 1) {
                step = mod(idx[1] - idx[0], list.length)
                for (let i = 2; i < n; i++) {
                    if (mod(idx[i] - idx[i - 1], list.length) !== step) return cycle
                }
            }
            return (k) => matchCase(list[mod(idx[0] + step * k, list.length)], seeds[mod(k, n)].trim())
        }
    }

    // Text ending in a number: "Item 1", "Q4", "2024-W01", "ORD-1001".
    const parts = seeds.map(s => TEXT_NUMBER.exec(s))
    if (parts.every(Boolean) && parts.every(p => p[1] === parts[0][1])) {
        const nums = parts.map(p => parseInt(p[2], 10))
        const step = n === 1 ? 1 : linearStep(nums)
        if (step !== null && Number.isInteger(step)) {
            return (k) => {
                const seedDigits = parts[mod(k, n)][2]
                const width = seedDigits.length > 1 && seedDigits.startsWith('0') ? seedDigits.length : 0
                const value = Math.abs(nums[0] + step * k)
                return parts[0][1] + String(value).padStart(width, '0')
            }
        }
    }

    return cycle
}

/**
 * Work out what dragging the fill handle from `source` to `target` writes.
 * `target` must contain `source` and extend it along one axis, or lie
 * inside it (dragging back shrinks: the cells left out are cleared).
 *
 * @param {{source, target, getRaw:(r,c)=>string, getStyle:(r,c)=>object|null}} args
 * @returns {{ writes: {row,col,raw,style}[], clears: {row,col}[] }}
 */
export function planFill({ source, target, getRaw, getStyle, copy = false }) {
    const writes = []
    const clears = []
    const inside = target.r1 >= source.r1 && target.r2 <= source.r2 && target.c1 >= source.c1 && target.c2 <= source.c2
    if (inside) {
        for (let r = source.r1; r <= source.r2; r++) {
            for (let c = source.c1; c <= source.c2; c++) {
                if (r < target.r1 || r > target.r2 || c < target.c1 || c > target.c2) clears.push({ row: r, col: c })
            }
        }
        return { writes, clears }
    }

    const vertical = target.c1 === source.c1 && target.c2 === source.c2
    if (vertical) {
        for (let c = source.c1; c <= source.c2; c++) {
            const seeds = []
            for (let r = source.r1; r <= source.r2; r++) seeds.push(getRaw(r, c))
            const gen = copy ? copyGenerator(seeds, 'row') : analyzeSeeds(seeds)
            const n = seeds.length
            for (let r = target.r1; r <= target.r2; r++) {
                if (r >= source.r1 && r <= source.r2) continue
                const k = r - source.r1
                writes.push({ row: r, col: c, raw: gen(k), style: getStyle(source.r1 + mod(k, n), c) })
            }
        }
    } else {
        for (let r = source.r1; r <= source.r2; r++) {
            const seeds = []
            for (let c = source.c1; c <= source.c2; c++) seeds.push(getRaw(r, c))
            const gen = copy ? copyGenerator(seeds, 'col') : horizontal(seeds)
            const n = seeds.length
            for (let c = target.c1; c <= target.c2; c++) {
                if (c >= source.c1 && c <= source.c2) continue
                const k = c - source.c1
                writes.push({ row: r, col: c, raw: gen(k), style: getStyle(r, source.c1 + mod(k, n)) })
            }
        }
    }
    return { writes, clears }
}

// Ctrl+D / Ctrl+R: repeat the seeds exactly, formulas shifted.
function copyGenerator(seeds, axis) {
    const n = seeds.length
    return (k) => {
        const i = mod(k, n)
        const seed = seeds[i]
        if (!seed.startsWith('=')) return seed
        return axis === 'row' ? shiftFormula(seed, k - i, 0) : shiftFormula(seed, 0, k - i)
    }
}

// Same analysis, but formulas shift along columns instead of rows.
function horizontal(seeds) {
    const n = seeds.length
    if (seeds.some(s => typeof s === 'string' && s.startsWith('='))) {
        return (k) => {
            const i = mod(k, n)
            const seed = seeds[i]
            return seed.startsWith('=') ? shiftFormula(seed, 0, k - i) : seed
        }
    }
    return analyzeSeeds(seeds)
}

/**
 * Snap a dragged pointer cell to a fill target: the selection grows
 * along whichever axis the pointer left it by more.
 */
export function fillTargetFor(source, row, col) {
    const down = row - source.r2, up = source.r1 - row
    const right = col - source.c2, left = source.c1 - col
    const vert = Math.max(down, up, 0)
    const horz = Math.max(right, left, 0)
    if (vert === 0 && horz === 0) {
        // Pointer is inside the selection: shrink from the bottom/right.
        const shrinkRows = source.r2 - row, shrinkCols = source.c2 - col
        if (shrinkRows >= shrinkCols && row >= source.r1) return { ...source, r2: row }
        if (col >= source.c1) return { ...source, c2: col }
        return source
    }
    if (vert >= horz) return down > 0 ? { ...source, r2: row } : { ...source, r1: row }
    return right > 0 ? { ...source, c2: col } : { ...source, c1: col }
}
