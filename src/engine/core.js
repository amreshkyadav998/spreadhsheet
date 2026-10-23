// ─────────────────────────────────────────────────────────────
//  Spreadsheet engine. No React, no DOM.
//
//  Data model (all positional state is keyed by cell id = row * STRIDE + col):
//    cells      Map<id, { raw, value, error, f }>   f = compiled formula or null
//    styles     Map<id, partial style>             only non-default keys
//    rowSizes / colSizes  Map<index, px>         only overrides
//    rowIds     number[]                          stable identity of each row
//    frozen     { rows, cols }
//    filters    Map<col, ColumnFilter>            a view: hides rows, never edits
//    sortState  { r1, r2, col, dir, order }       header-click cycle + original order
//
//  Every public mutation runs inside a transaction that records
//  reversible changes; one transaction is one undo step.
//  Structural edits (insert/delete/sort) are one primitive, `remap`,
//  that moves positional state, followed by recorded formula rewrites.
// ─────────────────────────────────────────────────────────────

import { compile, evaluate, FormulaError, ERR, rewriteRefs } from './formula.js'
import { isPlainNumber, isBlank } from './values.js'
import { DEFAULT_STYLE, compactStyle, sameStyle, formatValue } from './format.js'
import { planFill } from './fill.js'
import { orderRows } from './sort.js'
import { matchesFilter, isActiveFilter } from './filter.js'

const STRIDE = 16384
const MAX_UNDO_HISTORY = 200
export const DEFAULT_COL_WIDTH = 100
export const DEFAULT_ROW_HEIGHT = 24
export const TOTALS_LABEL = /^(grand\s+)?(total|totals|subtotal|sum)\b/i

const idOf = (row, col) => row * STRIDE + col
const rowOf = (id) => Math.floor(id / STRIDE)
const colOf = (id) => id % STRIDE

function positionMapper(op) {
    if (op.kind === 'insert') return (p) => (p >= op.at ? p + op.count : p)
    if (op.kind === 'delete') return (p) => (p < op.at ? p : p < op.at + op.count ? -1 : p - op.count)
    const map = new Map()
    for (let i = 0; i < op.from.length; i++) map.set(op.from[i], op.to[i])
    return (p) => (map.has(p) ? map.get(p) : p)
}

function invertOp(op) {
    if (op.kind === 'insert') return { ...op, kind: 'delete' }
    if (op.kind === 'delete') return { ...op, kind: 'insert' }
    return { kind: 'permute', from: op.to, to: op.from }
}

/**
 * How references move when rows/columns are inserted, deleted or permuted.
 * Insert/delete behave like every spreadsheet: references past the edit
 * shift, references into deleted cells become #REF!, ranges grow/shrink.
 * Permute (sort): single references follow their row; a range moves only
 * when it lies inside one row, so =SUM(J2:J32) over the block is unchanged.
 */
function refMapper(axis, op) {
    const key = axis === 'row' ? 'row' : 'col'
    const move = (ref, value) => (value === ref[key] ? ref : { ...ref, [key]: value })
    if (op.kind === 'insert') {
        const f = (p) => (p >= op.at ? p + op.count : p)
        return {
            cell: (ref) => move(ref, f(ref[key])),
            range: (a, b) => [move(a, f(a[key])), move(b, f(b[key]))],
        }
    }
    if (op.kind === 'delete') {
        const end = op.at + op.count
        return {
            cell: (ref) => {
                const p = ref[key]
                if (p >= op.at && p < end) return null
                return move(ref, p >= end ? p - op.count : p)
            },
            range: (a, b) => {
                const aTop = a[key] <= b[key]
                const lo = Math.min(a[key], b[key]), hi = Math.max(a[key], b[key])
                if (lo >= op.at && hi < end) return null
                const newLo = lo < op.at ? lo : lo < end ? op.at : lo - op.count
                const newHi = hi < op.at ? hi : hi < end ? op.at - 1 : hi - op.count
                return [move(a, aTop ? newLo : newHi), move(b, aTop ? newHi : newLo)]
            },
        }
    }
    const map = positionMapper(op)
    return {
        cell: (ref) => move(ref, map(ref[key])),
        range: (a, b) => (a[key] === b[key] ? [move(a, map(a[key])), move(b, map(b[key]))] : [a, b]),
    }
}

/** Cheap pre-check so a rewrite only tokenizes formulas the edit can affect. */
function formulaTouched(f, axis, op, movedSet) {
    if (!f.ast) return true
    const key = axis === 'row' ? 'row' : 'col'
    if (op.kind === 'permute') {
        for (const c of f.cells) if (movedSet.has(c[key])) return true
        for (const r of f.ranges) {
            const lo = axis === 'row' ? r.r1 : r.c1
            const hi = axis === 'row' ? r.r2 : r.c2
            if (lo === hi && movedSet.has(lo)) return true
        }
        return false
    }
    for (const c of f.cells) if (c[key] >= op.at) return true
    for (const r of f.ranges) if ((axis === 'row' ? r.r2 : r.c2) >= op.at) return true
    return false
}

function cloneFilters(map) {
    return new Map([...map].map(([col, f]) => [col, { values: f.values ? [...f.values] : null, cond: f.cond ? { ...f.cond } : null }]))
}

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    const cells = new Map()
    const styles = new Map()
    const rowSizes = new Map()
    const colSizes = new Map()
    let rowIds = Array.from({ length: rows }, (_, i) => i)
    let nextRowId = rows
    let frozen = { rows: 0, cols: 0 }
    let filters = new Map()
    let sortState = null

    // Dependency graph: precedent → dependents. Ranges are kept as
    // rectangles in per-column buckets instead of being expanded.
    const pointDeps = new Map()
    const rangeBuckets = new Map()
    const rangeEntries = new Map()

    const undoStack = []
    const redoStack = []
    let tx = null
    let replaying = false
    const dirty = new Set()
    let needFullRecalc = false
    // After a remap the graph is rebuilt once, lazily, at the next recalc,
    // instead of being patched for every formula the remap rewrites.
    let graphStale = false

    let version = 0
    const listeners = new Set()
    const memo = { usedAt: -1, used: null, hiddenAt: -1, hidden: null }

    function bump() {
        version++
        for (const fn of listeners) fn(version)
    }

    // ── Dependency graph ──

    function link(id, f) {
        for (const ref of f.cells) {
            const pid = idOf(ref.row, ref.col)
            let set = pointDeps.get(pid)
            if (!set) pointDeps.set(pid, (set = new Set()))
            set.add(id)
        }
        if (f.ranges.length) {
            const entries = []
            for (const rg of f.ranges) {
                const entry = { owner: id, r1: rg.r1, r2: rg.r2, c1: rg.c1, c2: Math.min(rg.c2, STRIDE - 1) }
                entries.push(entry)
                for (let c = entry.c1; c <= entry.c2; c++) {
                    let bucket = rangeBuckets.get(c)
                    if (!bucket) rangeBuckets.set(c, (bucket = new Set()))
                    bucket.add(entry)
                }
            }
            rangeEntries.set(id, entries)
        }
    }

    function unlink(id, f) {
        for (const ref of f.cells) {
            const pid = idOf(ref.row, ref.col)
            const set = pointDeps.get(pid)
            if (set) {
                set.delete(id)
                if (set.size === 0) pointDeps.delete(pid)
            }
        }
        const entries = rangeEntries.get(id)
        if (entries) {
            for (const entry of entries) {
                for (let c = entry.c1; c <= entry.c2; c++) rangeBuckets.get(c)?.delete(entry)
            }
            rangeEntries.delete(id)
        }
    }

    function rebuildGraph() {
        pointDeps.clear()
        rangeBuckets.clear()
        rangeEntries.clear()
        for (const [id, cell] of cells) if (cell.f && cell.f.ast) link(id, cell.f)
    }

    function dependentsOf(id) {
        const out = []
        const set = pointDeps.get(id)
        if (set) for (const d of set) out.push(d)
        const bucket = rangeBuckets.get(colOf(id))
        if (bucket) {
            const r = rowOf(id)
            for (const e of bucket) if (r >= e.r1 && r <= e.r2) out.push(e.owner)
        }
        return out
    }

    // ── Evaluation ──

    function valueAt(row, col) {
        const cell = cells.get(idOf(row, col))
        if (!cell) return ''
        return cell.error ? new FormulaError(cell.error) : cell.value
    }

    function forEachIdInRange(range, fn) {
        const r2 = Math.min(range.r2, rows - 1)
        const c2 = Math.min(range.c2, cols - 1)
        if (r2 < range.r1 || c2 < range.c1) return
        const area = (r2 - range.r1 + 1) * (c2 - range.c1 + 1)
        if (area <= cells.size) {
            for (let r = range.r1; r <= r2; r++) {
                for (let c = range.c1; c <= c2; c++) {
                    const id = idOf(r, c)
                    const cell = cells.get(id)
                    if (cell) fn(id, cell)
                }
            }
        } else {
            for (const [id, cell] of cells) {
                const r = rowOf(id), c = colOf(id)
                if (r >= range.r1 && r <= r2 && c >= range.c1 && c <= c2) fn(id, cell)
            }
        }
    }

    const evalContext = {
        get: valueAt,
        forEachInRange(range, fn) {
            forEachIdInRange(range, (id, cell) => fn(cell.error ? new FormulaError(cell.error) : cell.value))
        },
    }

    /** Reverse post-order DFS over dependents: a topological order plus the cells on cycles. */
    function topoOrder(sources) {
        const state = new Map()
        const stack = []
        const onStack = new Map()
        const post = []
        const cyclic = new Set()
        const push = (id) => {
            state.set(id, 1)
            onStack.set(id, stack.length)
            stack.push({ id, deps: dependentsOf(id), i: 0 })
        }
        for (const source of sources) {
            if (state.has(source)) continue
            push(source)
            while (stack.length) {
                const frame = stack[stack.length - 1]
                if (frame.i < frame.deps.length) {
                    const d = frame.deps[frame.i++]
                    const st = state.get(d)
                    if (st === undefined) push(d)
                    else if (st === 1) for (let k = onStack.get(d); k < stack.length; k++) cyclic.add(stack[k].id)
                } else {
                    stack.pop()
                    onStack.delete(frame.id)
                    state.set(frame.id, 2)
                    post.push(frame.id)
                }
            }
        }
        post.reverse()
        return { order: post, cyclic }
    }

    function recalc() {
        if (graphStale) {
            rebuildGraph()
            graphStale = false
        }
        let sources
        if (needFullRecalc) {
            sources = []
            for (const [id, cell] of cells) if (cell.f) sources.push(id)
            needFullRecalc = false
            dirty.clear()
        } else {
            if (dirty.size === 0) return
            sources = [...dirty]
            dirty.clear()
        }
        const { order, cyclic } = topoOrder(sources)
        for (const id of order) {
            const cell = cells.get(id)
            if (!cell || !cell.f) continue
            if (cell.f.error) {
                cell.value = null
                cell.error = cell.f.error
            } else if (cyclic.has(id)) {
                cell.value = null
                cell.error = ERR.CYCLE
            } else {
                const v = evaluate(cell.f.ast, evalContext)
                if (v instanceof FormulaError) {
                    cell.value = null
                    cell.error = v.code
                } else {
                    cell.value = v
                    cell.error = null
                }
            }
        }
    }

    // ── Raw writers (no undo bookkeeping) ──

    function writeRaw(row, col, raw) {
        const id = idOf(row, col)
        const old = cells.get(id)
        if (old && old.f && old.f.ast && !graphStale) unlink(id, old.f)
        dirty.add(id)
        if (raw === null || raw === undefined || raw.trim() === '') {
            cells.delete(id)
            return
        }
        if (raw.startsWith('=') && raw.length > 1) {
            const f = compile(raw)
            cells.set(id, { raw, value: null, error: f.error, f })
            if (f.ast && !graphStale) link(id, f)
        } else {
            cells.set(id, { raw, value: isPlainNumber(raw) ? Number(raw) : raw, error: null, f: null })
        }
    }

    function writeStyle(id, style) {
        if (style) styles.set(id, style)
        else styles.delete(id)
    }

    function sizeMap(axis) {
        return axis === 'row' ? rowSizes : colSizes
    }

    function rekey(map, isRow, mapper) {
        const moved = []
        for (const [id, value] of map) {
            const p = isRow ? rowOf(id) : colOf(id)
            const np = mapper(p)
            if (np !== p) moved.push(id, value, np)
        }
        for (let i = 0; i < moved.length; i += 3) map.delete(moved[i])
        for (let i = 0; i < moved.length; i += 3) {
            const id = moved[i], np = moved[i + 2]
            if (np < 0) continue
            map.set(isRow ? idOf(np, colOf(id)) : idOf(rowOf(id), np), moved[i + 1])
        }
    }

    function rekeyIndexMap(map, mapper) {
        const entries = [...map]
        map.clear()
        for (const [p, v] of entries) {
            const np = mapper(p)
            if (np >= 0) map.set(np, v)
        }
    }

    /** Move every piece of positional state along one axis. */
    function applyRemap(axis, op) {
        const isRow = axis === 'row'
        const mapper = positionMapper(op)
        rekey(cells, isRow, mapper)
        rekey(styles, isRow, mapper)
        rekeyIndexMap(sizeMap(axis), mapper)
        if (!isRow) rekeyIndexMap(filters, mapper)
        if (isRow) {
            if (op.kind === 'insert') rowIds.splice(op.at, 0, ...op.ids)
            else if (op.kind === 'delete') rowIds.splice(op.at, op.count)
            else {
                const next = rowIds.slice()
                for (let i = 0; i < op.from.length; i++) next[op.to[i]] = rowIds[op.from[i]]
                rowIds = next
            }
        }
        const delta = op.kind === 'insert' ? op.count : op.kind === 'delete' ? -op.count : 0
        if (isRow) rows += delta
        else cols += delta
        graphStale = true
        needFullRecalc = true
    }

    // ── Recorded mutators: each one logs a reversible change ──

    function record(change) {
        if (tx && !replaying) tx.changes.push(change)
    }

    function putRaw(row, col, raw) {
        const text = raw === null || raw === undefined ? '' : String(raw)
        const next = text.trim() === '' ? '' : text
        const before = cells.get(idOf(row, col))?.raw ?? ''
        if (before === next) return false
        record({ t: 'cell', row, col, before, after: next })
        writeRaw(row, col, next)
        return true
    }

    function putStyle(row, col, style) {
        const id = idOf(row, col)
        const before = styles.get(id) || null
        const after = compactStyle(style)
        if (sameStyle(before, after)) return false
        record({ t: 'style', id, before, after })
        writeStyle(id, after)
        return true
    }

    function putSize(axis, index, size) {
        const map = sizeMap(axis)
        const before = map.has(index) ? map.get(index) : null
        const after = size === null || size === undefined ? null : Math.round(size)
        if (before === after) return false
        record({ t: 'size', axis, index, before, after })
        if (after === null) map.delete(index)
        else map.set(index, after)
        return true
    }

    function putFrozen(next) {
        if (next.rows === frozen.rows && next.cols === frozen.cols) return false
        record({ t: 'frozen', before: frozen, after: next })
        frozen = next
        return true
    }

    function putFilters(next) {
        record({ t: 'filters', before: cloneFilters(filters), after: cloneFilters(next) })
        filters = cloneFilters(next)
    }

    function putSortState(next) {
        if (next === sortState) return
        record({ t: 'sortState', before: sortState, after: next })
        sortState = next
    }

    function doRemap(axis, op) {
        record({ t: 'remap', axis, op })
        applyRemap(axis, op)
    }

    function rewriteFormulas(axis, op) {
        const mapper = refMapper(axis, op)
        const movedSet = op.kind === 'permute' ? new Set(op.from) : null
        const updates = []
        for (const [id, cell] of cells) {
            if (!cell.f || !formulaTouched(cell.f, axis, op, movedSet)) continue
            const next = rewriteRefs(cell.raw, mapper)
            if (next !== cell.raw) updates.push(rowOf(id), colOf(id), next)
        }
        for (let i = 0; i < updates.length; i += 3) putRaw(updates[i], updates[i + 1], updates[i + 2])
    }

    function applyChange(ch, forward) {
        switch (ch.t) {
            case 'cell': writeRaw(ch.row, ch.col, forward ? ch.after : ch.before); break
            case 'style': writeStyle(ch.id, forward ? ch.after : ch.before); break
            case 'size': {
                const v = forward ? ch.after : ch.before
                if (v === null) sizeMap(ch.axis).delete(ch.index)
                else sizeMap(ch.axis).set(ch.index, v)
                break
            }
            case 'frozen': frozen = forward ? ch.after : ch.before; break
            case 'filters': filters = cloneFilters(forward ? ch.after : ch.before); break
            case 'sortState': sortState = forward ? ch.after : ch.before; break
            case 'remap': applyRemap(ch.axis, forward ? ch.op : invertOp(ch.op)); break
        }
    }

    function replay(changes, forward) {
        replaying = true
        try {
            if (forward) for (const ch of changes) applyChange(ch, true)
            else for (let i = changes.length - 1; i >= 0; i--) applyChange(changes[i], false)
        } finally {
            replaying = false
        }
        recalc()
    }

    /**
     * Run fn as one undoable step. Nested calls join the outer step.
     * If fn throws, everything it changed is rolled back.
     */
    function transact(label, fn) {
        if (tx) return fn()
        tx = { label, changes: [] }
        let result
        try {
            result = fn()
        } catch (e) {
            const failed = tx
            tx = null
            replay(failed.changes, false)
            bump()
            throw e
        }
        const done = tx
        tx = null
        recalc()
        if (done.changes.length) {
            undoStack.push(done)
            if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
            redoStack.length = 0
        }
        bump()
        return result
    }

    function undo() {
        if (tx || undoStack.length === 0) return false
        const entry = undoStack.pop()
        replay(entry.changes, false)
        redoStack.push(entry)
        bump()
        return true
    }

    function redo() {
        if (tx || redoStack.length === 0) return false
        const entry = redoStack.pop()
        replay(entry.changes, true)
        undoStack.push(entry)
        bump()
        return true
    }

    // ── Reads ──

    function getCell(row, col) {
        const cell = cells.get(idOf(row, col))
        if (!cell) return { raw: '', computed: '', error: null }
        if (cell.error) return { raw: cell.raw, computed: null, error: cell.error }
        return { raw: cell.raw, computed: cell.value, error: null }
    }

    function getRaw(row, col) {
        return cells.get(idOf(row, col))?.raw ?? ''
    }

    /** Computed value: number | string | '' (empty) | error code string. */
    function getValue(row, col) {
        const cell = cells.get(idOf(row, col))
        if (!cell) return ''
        return cell.error ? cell.error : cell.value
    }

    /** Cell text as data: literal text as typed, formulas as their result. */
    function getText(row, col) {
        const cell = cells.get(idOf(row, col))
        if (!cell) return ''
        if (cell.error) return cell.error
        return cell.f ? cell.value : cell.raw
    }

    function getStyle(row, col) {
        const s = styles.get(idOf(row, col))
        return s ? { ...DEFAULT_STYLE, ...s } : { ...DEFAULT_STYLE }
    }

    function getStoredStyle(row, col) {
        return styles.get(idOf(row, col)) || null
    }

    /** What the grid shows: errors, or the value under the cell's number format. */
    function getDisplay(row, col) {
        const cell = cells.get(idOf(row, col))
        if (!cell) return ''
        if (cell.error) return cell.error
        const s = styles.get(idOf(row, col))
        if (!cell.f && (!s || !s.numberFormat || s.numberFormat === 'general')) return cell.raw
        return formatValue(cell.value, s ? s.numberFormat : 'general')
    }

    /** Bounding box of non-empty cells, or null for an empty sheet. */
    function getUsedRange() {
        if (memo.usedAt === version) return memo.used
        let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1
        for (const id of cells.keys()) {
            const r = rowOf(id), c = colOf(id)
            if (r < r1) r1 = r
            if (r > r2) r2 = r
            if (c < c1) c1 = c
            if (c > c2) c2 = c
        }
        memo.used = r2 < 0 ? null : { r1, c1, r2, c2 }
        memo.usedAt = version
        return memo.used
    }

    /** Values of a range as a 2-D array (getText semantics). */
    function getRangeValues(range) {
        const out = []
        for (let r = range.r1; r <= range.r2; r++) {
            const line = new Array(range.c2 - range.c1 + 1)
            for (let c = range.c1; c <= range.c2; c++) line[c - range.c1] = getText(r, c)
            out.push(line)
        }
        return out
    }

    // A row with no literal data. Formula-only rows count as empty so a blank
    // data row still sorts last after a helper column is filled down past it.
    function isRowEmpty(row, c1, c2) {
        for (let c = c1; c <= c2; c++) {
            const cell = cells.get(idOf(row, c))
            if (cell && !cell.f) return false
        }
        return true
    }

    function firstFilledText(row, c1, c2) {
        for (let c = c1; c <= c2; c++) {
            const v = getText(row, c)
            if (!isBlank(v)) return String(v).trim()
        }
        return ''
    }

    /** The last used row when its first filled cell reads like "Total". */
    function getTotalsRow() {
        const used = getUsedRange()
        if (!used || used.r2 === used.r1) return null
        return TOTALS_LABEL.test(firstFilledText(used.r2, used.c1, used.c2)) ? used.r2 : null
    }

    // ── Edits ──

    function setCell(row, col, raw) {
        transact('Edit cell', () => putRaw(row, col, raw ?? ''))
    }

    /** Write many cells as one undo step. updates: [{ row, col, raw }] */
    function setCells(updates, label = 'Edit cells') {
        transact(label, () => {
            for (const u of updates) {
                if (u.row >= rows || u.col >= cols) ensureCapacity(u.row + 1, u.col + 1)
                putRaw(u.row, u.col, u.raw ?? '')
            }
        })
    }

    /** Write a 2-D block of raw values with its top-left at (row, col). */
    function writeBlock(row, col, matrix, label = 'Insert values') {
        const updates = []
        matrix.forEach((line, i) => line.forEach((raw, j) => updates.push({ row: row + i, col: col + j, raw: raw === null || raw === undefined ? '' : String(raw) })))
        setCells(updates, label)
    }

    /** Delete/Backspace: clear contents (not formatting) of a range. */
    function clearContents(range) {
        transact('Clear', () => {
            const targets = []
            forEachIdInRange(range, (id) => targets.push(id))
            for (const id of targets) putRaw(rowOf(id), colOf(id), '')
        })
    }

    function clearAll() {
        transact('Clear all', () => {
            for (const id of [...cells.keys()]) putRaw(rowOf(id), colOf(id), '')
            for (const id of [...styles.keys()]) putStyle(rowOf(id), colOf(id), null)
        })
    }

    // ── Styles ──

    function forEachPosition(range, fn) {
        const r2 = Math.min(range.r2, rows - 1)
        const c2 = Math.min(range.c2, cols - 1)
        for (let r = range.r1; r <= r2; r++) for (let c = range.c1; c <= c2; c++) fn(r, c)
    }

    /** Merge a style patch into every cell of a range (one undo step). */
    function setStyle(range, patch) {
        transact('Format', () => {
            forEachPosition(range, (r, c) => {
                const current = styles.get(idOf(r, c))
                putStyle(r, c, { ...current, ...patch })
            })
        })
    }

    function clearStyles(range) {
        transact('Clear formatting', () => {
            const targets = []
            for (const id of styles.keys()) {
                const r = rowOf(id), c = colOf(id)
                if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) targets.push(id)
            }
            for (const id of targets) putStyle(rowOf(id), colOf(id), null)
        })
    }

    /**
     * Apply a precomputed formatting patch as one undo step.
     * patch = { styles?: [{row,col,style}], freezeRows?: number, colWidths?: [{col,width}] }
     * @returns {boolean} whether anything changed
     */
    function applyFormatPatch(patch, label = 'Format sheet') {
        const before = undoStack.length
        transact(label, () => {
            for (const s of patch.styles || []) putStyle(s.row, s.col, s.style)
            if (typeof patch.freezeRows === 'number') putFrozen({ ...frozen, rows: patch.freezeRows })
            for (const w of patch.colWidths || []) putSize('col', w.col, w.width)
        })
        return undoStack.length !== before
    }

    // ── Sizes and freeze ──

    function setColWidth(col, width) {
        transact('Resize column', () => putSize('col', col, width === DEFAULT_COL_WIDTH ? null : width))
    }

    function setRowHeight(row, height) {
        transact('Resize row', () => putSize('row', row, height === DEFAULT_ROW_HEIGHT ? null : height))
    }

    function setFrozen(next) {
        transact('Freeze', () => putFrozen({ rows: Math.max(0, next.rows ?? frozen.rows), cols: Math.max(0, next.cols ?? frozen.cols) }))
    }

    // ── Structure ──

    function insertRows(at, count = 1) {
        transact('Insert row', () => {
            putSortState(null)
            const ids = []
            for (let i = 0; i < count; i++) ids.push(nextRowId++)
            const op = { kind: 'insert', at, count, ids }
            doRemap('row', op)
            rewriteFormulas('row', op)
        })
    }

    function deleteRows(at, count = 1) {
        if (at < 0 || at >= rows) return
        count = Math.min(count, rows - at)
        transact('Delete row', () => {
            putSortState(null)
            const band = { r1: at, r2: at + count - 1, c1: 0, c2: STRIDE - 1 }
            clearBand(band)
            for (let r = at; r < at + count; r++) putSize('row', r, null)
            const op = { kind: 'delete', at, count, ids: rowIds.slice(at, at + count) }
            doRemap('row', op)
            rewriteFormulas('row', op)
        })
    }

    function insertColumns(at, count = 1) {
        transact('Insert column', () => {
            putSortState(null)
            const op = { kind: 'insert', at, count }
            doRemap('col', op)
            rewriteFormulas('col', op)
        })
    }

    function deleteColumns(at, count = 1) {
        if (at < 0 || at >= cols) return
        count = Math.min(count, cols - at)
        transact('Delete column', () => {
            putSortState(null)
            clearBand({ r1: 0, r2: rows - 1, c1: at, c2: at + count - 1 })
            for (let c = at; c < at + count; c++) putSize('col', c, null)
            let touched = false
            const next = cloneFilters(filters)
            for (let c = at; c < at + count; c++) if (next.delete(c)) touched = true
            if (touched) putFilters(next)
            const op = { kind: 'delete', at, count }
            doRemap('col', op)
            rewriteFormulas('col', op)
        })
    }

    // Empty a rectangle (content and style) so a delete remap loses nothing.
    function clearBand(band) {
        const ids = []
        forEachIdInRange(band, (id) => ids.push(id))
        for (const id of ids) putRaw(rowOf(id), colOf(id), '')
        const styled = []
        for (const id of styles.keys()) {
            const r = rowOf(id), c = colOf(id)
            if (r >= band.r1 && r <= band.r2 && c >= band.c1 && c <= band.c2) styled.push(id)
        }
        for (const id of styled) putStyle(rowOf(id), colOf(id), null)
    }

    function ensureCapacity(minRows, minCols) {
        if (minRows > rows) {
            for (let r = rows; r < minRows; r++) rowIds.push(nextRowId++)
            rows = minRows
        }
        if (minCols > cols) cols = Math.min(minCols, STRIDE)
    }

    // ── Fill ──

    /**
     * Fill handle: extend `source` to `target` (or shrink back into it).
     * opts.copy: copy exactly instead of continuing series (Ctrl+D).
     */
    function fill(source, target, opts = {}) {
        const t = {
            r1: Math.max(0, target.r1), c1: Math.max(0, target.c1),
            r2: Math.min(target.r2, rows - 1), c2: Math.min(target.c2, cols - 1),
        }
        transact(opts.copy ? 'Fill down' : 'Fill', () => {
            const plan = planFill({ source, target: t, getRaw, getStyle: getStoredStyle, copy: !!opts.copy })
            for (const w of plan.writes) {
                putRaw(w.row, w.col, w.raw)
                putStyle(w.row, w.col, w.style)
            }
            for (const c of plan.clears) putRaw(c.row, c.col, '')
        })
    }

    // ── Filters ──

    function getHiddenRows() {
        if (memo.hiddenAt === version) return memo.hidden
        const hidden = new Set()
        const used = getUsedRange()
        const active = [...filters].filter(([, f]) => isActiveFilter(f))
        if (used && active.length) {
            for (let r = used.r1 + 1; r <= used.r2; r++) {
                for (const [col, f] of active) {
                    if (!matchesFilter(getText(r, col), f)) {
                        hidden.add(r)
                        break
                    }
                }
            }
        }
        memo.hidden = hidden
        memo.hiddenAt = version
        return hidden
    }

    /** Set (or with null, clear) the filter of one column. One undo step. */
    function setFilter(col, filter) {
        transact(filter ? 'Filter' : 'Clear filter', () => {
            const next = cloneFilters(filters)
            if (isActiveFilter(filter)) next.set(col, filter)
            else if (!next.delete(col)) return
            putFilters(next)
        })
    }

    function clearFilters() {
        if (filters.size === 0) return
        transact('Clear filters', () => putFilters(new Map()))
    }

    function getFilterStatus() {
        const used = getUsedRange()
        const total = used ? used.r2 - used.r1 : 0
        return { total, visible: total - getHiddenRows().size, active: filters.size > 0 }
    }

    // ── Sort ──

    /**
     * The rows a header click sorts: a multi-row selection as-is, otherwise
     * the used range minus its header row and a trailing totals row.
     */
    function getSortBlock(selection) {
        if (selection && selection.r2 > selection.r1 && !(selection.r1 === 0 && selection.r2 >= rows - 1)) {
            return { r1: selection.r1, r2: selection.r2, c1: 0, c2: cols - 1, header: false, totalsRow: null }
        }
        const used = getUsedRange()
        if (!used || used.r2 <= used.r1) return null
        const totalsRow = getTotalsRow()
        return { r1: used.r1 + 1, r2: totalsRow === null ? used.r2 : used.r2 - 1, c1: used.c1, c2: used.c2, header: true, totalsRow }
    }

    /**
     * Sort the rows of a block by one column. dir: 'asc' | 'desc' | 'original'.
     * Hidden (filtered) rows keep their positions; visible rows are reordered
     * among the visible slots. Whole rows move: cells, styles, heights, identity.
     */
    function sortRows(block, col, dir) {
        if (!block) return
        transact('Sort', () => {
            const hidden = getHiddenRows()
            const slots = []
            for (let r = block.r1; r <= block.r2; r++) if (!hidden.has(r)) slots.push(r)
            const sameCycle = sortState && sortState.r1 === block.r1 && sortState.r2 === block.r2
            const order = sameCycle ? sortState.order : rowIds.slice(block.r1, block.r2 + 1)
            let sorted
            if (dir === 'original') {
                const rank = new Map(order.map((rowId, i) => [rowId, i]))
                sorted = slots.slice().sort((a, b) => (rank.get(rowIds[a]) ?? Infinity) - (rank.get(rowIds[b]) ?? Infinity) || a - b)
            } else {
                const c1 = block.c1, c2 = block.c2
                sorted = orderRows(slots, (r) => getText(r, col), dir, (r) => isRowEmpty(r, c1, c2))
            }
            putSortState(dir === 'original' ? null : { r1: block.r1, r2: block.r2, col, dir, order })
            const from = [], to = []
            for (let i = 0; i < slots.length; i++) {
                if (sorted[i] !== slots[i]) {
                    from.push(sorted[i])
                    to.push(slots[i])
                }
            }
            if (from.length) {
                const op = { kind: 'permute', from, to }
                doRemap('row', op)
                rewriteFormulas('row', op)
            }
        })
    }

    /** Header click: ascending → descending → original order. Returns the applied direction. */
    function cycleSort(col, selection) {
        const block = getSortBlock(selection)
        if (!block) return null
        const same = sortState && sortState.r1 === block.r1 && sortState.r2 === block.r2 && sortState.col === col
        const dir = !same ? 'asc' : sortState.dir === 'asc' ? 'desc' : 'original'
        sortRows(block, col, dir)
        return dir
    }

    // ── Public API ──

    return {
        get rows() { return rows },
        get cols() { return cols },
        get version() { return version },
        get frozen() { return { ...frozen } },
        get undoDepth() { return undoStack.length },
        subscribe(fn) {
            listeners.add(fn)
            return () => listeners.delete(fn)
        },

        // cells
        getCell,
        getRaw,
        getValue,
        getText,
        getDisplay,
        getRangeValues,
        getUsedRange,
        getTotalsRow,
        setCell,
        setCells,
        writeBlock,
        clearContents,
        clearAll,
        fill,
        batch: transact,

        // styles, sizes, freeze
        getStyle,
        getStoredStyle,
        setStyle,
        clearStyles,
        applyFormatPatch,
        getColWidth: (col) => colSizes.get(col) ?? DEFAULT_COL_WIDTH,
        getRowHeight: (row) => rowSizes.get(row) ?? DEFAULT_ROW_HEIGHT,
        getSizeOverrides: (axis) => new Map(sizeMap(axis)),
        setColWidth,
        setRowHeight,
        setFrozen,

        // structure
        insertRow: (at, count) => insertRows(at, count),
        deleteRow: (at, count) => deleteRows(at, count),
        insertColumn: (at, count) => insertColumns(at, count),
        deleteColumn: (at, count) => deleteColumns(at, count),
        ensureCapacity,
        getRowId: (row) => rowIds[row],

        // filter and sort
        getFilters: () => cloneFilters(filters),
        setFilter,
        clearFilters,
        getHiddenRows,
        getFilterStatus,
        getSortBlock,
        getSortState: () => (sortState ? { col: sortState.col, dir: sortState.dir, r1: sortState.r1, r2: sortState.r2 } : null),
        sortRows,
        cycleSort,

        // history
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        undoLabel: () => undoStack[undoStack.length - 1]?.label ?? null,
        redoLabel: () => redoStack[redoStack.length - 1]?.label ?? null,
    }
}
