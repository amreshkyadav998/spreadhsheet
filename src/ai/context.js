// ─────────────────────────────────────────────────────────────
//  The sheet context sent to the model (AI_CONTRACT.md §1).
//  Headers, an inferred type per column, five sample rows, the row
//  count and the selection. Never the full data.
// ─────────────────────────────────────────────────────────────

import { norm, toNum, parseDateParts, isBlank } from '../engine/values.js'
import { rangeName } from '../engine/formula.js'
import { isTotalsRow } from './executor.js'

const SAMPLE_ROWS = 5
const TYPE_SAMPLE = 200
const EXAMPLES = 3

/** number | currency | percent | date | text | id, from up to 200 non-empty values. */
export function inferType(name, values) {
    const vals = values.filter(v => !isBlank(v)).slice(0, TYPE_SAMPLE).map(v => String(v).trim())
    if (vals.length === 0) return 'text'
    const share = (pred) => vals.filter(pred).length / vals.length
    if (/\bid\b|^id|id$/i.test(name.trim()) && new Set(vals.map(norm)).size >= vals.length * 0.9) return 'id'
    if (share(v => parseDateParts(v) !== null) >= 0.8) return 'date'
    const numeric = share(v => toNum(v) !== null)
    if (numeric >= 0.7) {
        if (share(v => v.includes('$')) >= 0.5) return 'currency'
        if (share(v => v.includes('%')) >= 0.3) return 'percent'
        return 'number'
    }
    if (share(v => /^[A-Za-z]+-?\d+$/.test(v)) >= 0.9 && new Set(vals.map(norm)).size === vals.length) return 'id'
    return 'text'
}

/**
 * @param {{ header: string[], rows: any[][], range: object|null }} table  from sheetTable()
 * @param {{r1,c1,r2,c2}|null} selection
 */
export function buildContext(table, selection) {
    if (!table.range) {
        return { range: null, rowCount: 0, columns: [], sampleRows: [], selection: selection ? rangeName(selection) : null, hasTotalsRow: false }
    }
    const dataRows = table.rows.filter(r => r.some(v => !isBlank(v)))
    const hasTotalsRow = dataRows.length > 0 && isTotalsRow(dataRows[dataRows.length - 1])
    const body = hasTotalsRow ? dataRows.slice(0, -1) : dataRows
    const columns = table.header.map((name, index) => {
        const values = body.map(r => r[index])
        const examples = []
        const seen = new Set()
        for (const v of values) {
            if (isBlank(v) || seen.has(norm(v))) continue
            seen.add(norm(v))
            examples.push(String(v))
            if (examples.length === EXAMPLES) break
        }
        return { name, index, type: inferType(name, values), examples }
    })
    return {
        range: rangeName(table.range),
        rowCount: body.length,
        columns,
        sampleRows: body.slice(0, SAMPLE_ROWS).map(r => r.map(v => (v === null || v === undefined ? '' : String(v)))),
        selection: selection ? rangeName(selection) : null,
        hasTotalsRow,
    }
}
