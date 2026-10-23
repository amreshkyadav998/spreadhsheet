// ─────────────────────────────────────────────────────────────
//  Query executor (AI_CONTRACT.md §3). A pure function from a
//  validated plan and a SheetTable to a result. Every number the
//  user sees comes from here, never from the model.
// ─────────────────────────────────────────────────────────────

import { ACTION_TYPES, FILTER_OPS, AGGREGATE_FNS, MAX_RESULT_ROWS } from './contract.js'
import { norm, toNum, toDate, isBlank } from '../engine/values.js'
import { TOTALS_LABEL } from '../engine/core.js'

const fail = (error, detail = error) => ({ error, detail })

/** Last row is a totals row when its first non-empty cell reads "Total", "Grand total", "Subtotal", "Sum". */
export function isTotalsRow(row) {
    const first = row.find(v => !isBlank(v))
    return first !== undefined && TOTALS_LABEL.test(String(first).trim())
}

function filterMatches(cell, op, value) {
    switch (op) {
        case 'eq':
        case 'neq': {
            const a = toNum(cell), b = toNum(value)
            const equal = a !== null && b !== null ? a === b : norm(cell) === norm(value)
            return op === 'eq' ? equal : !equal
        }
        case 'gt': case 'gte': case 'lt': case 'lte': {
            let a, b
            const vDate = toDate(value)
            if (vDate) {
                a = toDate(cell)
                b = vDate
                if (a === null) return false
            } else {
                a = toNum(cell)
                b = toNum(value)
                if (a === null || b === null) return false
            }
            if (op === 'gt') return a > b
            if (op === 'gte') return a >= b
            if (op === 'lt') return a < b
            return a <= b
        }
        case 'contains': return norm(cell).includes(norm(value))
        case 'startsWith': return norm(cell).startsWith(norm(value))
        case 'endsWith': return norm(cell).endsWith(norm(value))
        case 'isEmpty': return norm(cell) === ''
        case 'notEmpty': return norm(cell) !== ''
    }
    return false
}

function aggregate(fn, rows, col) {
    if (fn === 'count') {
        let n = 0
        for (const r of rows) if (!isBlank(r[col])) n++
        return n
    }
    if (fn === 'countDistinct') {
        const seen = new Set()
        for (const r of rows) {
            const k = norm(r[col])
            if (k !== '') seen.add(k)
        }
        return seen.size
    }
    let count = 0, sum = 0, min = Infinity, max = -Infinity
    for (const r of rows) {
        const n = toNum(r[col])
        if (n === null) continue
        count++
        sum += n
        if (n < min) min = n
        if (n > max) max = n
    }
    if (count === 0) return null
    if (fn === 'sum') return sum
    if (fn === 'avg') return sum / count
    if (fn === 'min') return min
    return max
}

function compareValues(a, b) {
    const na = toNum(a), nb = toNum(b)
    if (na !== null && nb !== null) return na - nb
    if (na !== null) return -1
    if (nb !== null) return 1
    const ta = norm(a), tb = norm(b)
    return ta < tb ? -1 : ta > tb ? 1 : 0
}

/**
 * @param {object} plan    a validated `query` action
 * @param {{ header: string[], rows: any[][] }} table
 * @returns {{ columns: string[], rows: any[][], rowCount: number, truncated: boolean }
 *         | { error: string, detail: string }}
 */
export function executeQuery(plan, table) {
    if (!plan || plan.type !== ACTION_TYPES.QUERY) return fail('READ_ONLY')

    const index = new Map()
    table.header.forEach((name, i) => {
        const key = norm(name)
        if (key && !index.has(key)) index.set(key, i)
    })
    const resolve = (name) => index.get(norm(name))
    const unknown = (name) => fail('UNKNOWN_COLUMN', `UNKNOWN_COLUMN:${name}`)

    const filters = plan.filters || []
    const groupBy = plan.groupBy || []
    const aggregates = plan.aggregates || []
    for (const f of filters) {
        if (resolve(f.column) === undefined) return unknown(f.column)
        if (!FILTER_OPS.includes(f.op)) return fail('UNKNOWN_OP', `UNKNOWN_OP:${f.op}`)
    }
    for (const g of groupBy) if (resolve(g) === undefined) return unknown(g)
    for (const a of aggregates) {
        if (resolve(a.column) === undefined) return unknown(a.column)
        if (!AGGREGATE_FNS.includes(a.fn)) return fail('UNKNOWN_FN', `UNKNOWN_FN:${a.fn}`)
    }
    for (const c of plan.columns || []) if (resolve(c) === undefined) return unknown(c)

    // §3.1 rows: skip blank rows, drop the totals row unless asked not to.
    let rows = table.rows.filter(r => r.some(v => !isBlank(v)))
    if (plan.excludeTotalsRow !== false && rows.length && isTotalsRow(rows[rows.length - 1])) rows = rows.slice(0, -1)

    // §3.3 filters, all must hold.
    if (filters.length) {
        const compiled = filters.map(f => ({ col: resolve(f.column), op: f.op, value: f.value }))
        rows = rows.filter(r => compiled.every(f => filterMatches(r[f.col], f.op, f.value)))
    }

    let columns, out, sortSource = null
    if (groupBy.length || aggregates.length) {
        // §3.4 group on normalised keys, label with the first row seen.
        const gcols = groupBy.map(resolve)
        const groups = new Map()
        if (gcols.length === 0) groups.set('', { label: [], rows })
        else {
            for (const r of rows) {
                const key = gcols.map(c => norm(r[c])).join('\u0000')
                let g = groups.get(key)
                if (!g) groups.set(key, (g = { label: gcols.map(c => (isBlank(r[c]) ? '' : String(r[c]).trim())), rows: [] }))
                g.rows.push(r)
            }
        }
        columns = [...gcols.map(c => table.header[c]), ...aggregates.map(a => a.as || `${a.fn}(${a.column})`)]
        out = []
        for (const g of groups.values()) {
            out.push([...g.label, ...aggregates.map(a => aggregate(a.fn, g.rows, resolve(a.column)))])
        }
    } else {
        // Row results: raw cell text projected on `columns` (default all).
        const pcols = plan.columns && plan.columns.length ? plan.columns.map(resolve) : table.header.map((_, i) => i)
        columns = pcols.map(c => table.header[c])
        out = rows.map(r => pcols.map(c => (r[c] === undefined ? '' : r[c])))
        sortSource = rows
    }

    // §3.5 multi-key stable sort on output columns (or, for row results, source columns).
    const sort = plan.sort || []
    if (sort.length) {
        const keys = []
        for (const s of sort) {
            const outIdx = columns.findIndex(c => norm(c) === norm(s.column))
            if (outIdx !== -1) keys.push({ get: (i) => out[i][outIdx], sign: s.dir === 'desc' ? -1 : 1 })
            else if (sortSource && resolve(s.column) !== undefined) {
                const src = resolve(s.column)
                keys.push({ get: (i) => sortSource[i][src], sign: s.dir === 'desc' ? -1 : 1 })
            } else return fail('UNKNOWN_SORT_COLUMN', `UNKNOWN_SORT_COLUMN:${s.column}`)
        }
        const order = out.map((_, i) => i)
        order.sort((x, y) => {
            for (const k of keys) {
                const c = compareValues(k.get(x), k.get(y))
                if (c !== 0) return c * k.sign
            }
            return x - y
        })
        out = order.map(i => out[i])
    }

    const limit = Math.min(Number.isInteger(plan.limit) && plan.limit > 0 ? plan.limit : MAX_RESULT_ROWS, MAX_RESULT_ROWS)
    const truncated = out.length > limit
    if (truncated) out = out.slice(0, limit)
    return { columns, rows: out, rowCount: out.length, truncated }
}

/** Display rounding used by the result card and the golden comparison. */
export function roundForDisplay(v) {
    return typeof v === 'number' ? Math.round(v * 100) / 100 : v
}
