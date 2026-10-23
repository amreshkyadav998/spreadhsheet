// ─────────────────────────────────────────────────────────────
//  format_sheet applier (AI_CONTRACT.md §4). planFormat is pure:
//  it reads the sheet through a small read-only view and returns a
//  patch; engine.applyFormatPatch applies it as one undo step.
//
//  SheetView = { getUsedRange(), getText(r,c), getValue(r,c),
//                getStoredStyle(r,c), getColWidth(c), frozen }
//  (the engine object satisfies it).
// ─────────────────────────────────────────────────────────────

import { compactStyle, sameStyle, formatValue, DEFAULT_STYLE } from '../engine/format.js'
import { toNum, isBlank } from '../engine/values.js'
import { TOTALS_LABEL } from '../engine/core.js'

const MIN_WIDTH = 30
const MAX_WIDTH = 600
const AUTOFIT_PADDING = 16

/** Rough text width when no canvas is available (tests, Node benchmarks). */
export function estimateTextWidth(text, style) {
    const size = style.fontSize || DEFAULT_STYLE.fontSize
    return String(text).length * size * (style.bold ? 0.6 : 0.55)
}

/**
 * §4.2: the last used row is a totals row if its first filled cell reads
 * "Total"/"Subtotal"/…, or it reads as a summary line: a non-numeric label
 * first, then only numbers, at least two filled cells, not all filled.
 */
export function looksLikeTotals(values) {
    const filled = values.filter(v => !isBlank(v))
    if (filled.length === 0) return false
    if (TOTALS_LABEL.test(String(filled[0]).trim())) return true
    if (filled.length < 2 || filled.length === values.length) return false
    if (toNum(filled[0]) !== null) return false
    return filled.slice(1).every(v => toNum(v) !== null)
}

const withoutNumberFormat = (style) => {
    if (!style || style.numberFormat === undefined) return style
    const rest = { ...style }
    delete rest.numberFormat
    return rest
}

/**
 * @param {object} action  a validated format_sheet action
 * @param {object} sheet   SheetView
 * @param {{ measureText?: (text:string, style:object) => number }} [opts]
 * @returns {{ result: 'OK'|'NO_CHANGES'|'OUT_OF_RANGE', message: string,
 *             patch: { styles: {row,col,style}[], freezeRows?: number, colWidths: {col,width}[] },
 *             totalsRow: number|null, droppedTotals: boolean }}
 */
export function planFormat(action, sheet, opts = {}) {
    const measure = opts.measureText || estimateTextWidth
    const empty = { styles: [], colWidths: [] }
    const used = sheet.getUsedRange()
    if (!used) return { result: 'NO_CHANGES', message: 'The sheet is empty.', patch: empty, totalsRow: null, droppedTotals: false }

    const headerRow = used.r1
    const lastRow = used.r2
    const colCount = used.c2 - used.c1 + 1
    const usedRowCount = lastRow - headerRow + 1

    // §4.5: refuse a freeze that would cover the whole table, apply nothing.
    if (typeof action.freezeRows === 'number' && action.freezeRows >= usedRowCount) {
        return {
            result: 'OUT_OF_RANGE',
            message: `Freezing ${action.freezeRows} rows would freeze all ${usedRowCount} used rows. Nothing was changed.`,
            patch: empty, totalsRow: null, droppedTotals: false,
        }
    }

    const hasBody = lastRow > headerRow
    let totalsRow = null
    if (hasBody) {
        const values = []
        for (let c = used.c1; c <= used.c2; c++) values.push(sheet.getText(lastRow, c))
        if (looksLikeTotals(values)) totalsRow = lastRow
    }
    const droppedTotals = !!action.totalsStyle && totalsRow === null

    // Working copy of every style in the used range, keyed by "r,c".
    const work = new Map()
    const keyOf = (r, c) => r * 16384 + c
    const current = (r, c) => {
        const k = keyOf(r, c)
        return work.has(k) ? work.get(k) : sheet.getStoredStyle(r, c)
    }
    const merge = (r, c, patch) => work.set(keyOf(r, c), { ...(current(r, c) || {}), ...patch })

    if (action.clearFormatting) {
        for (let r = headerRow; r <= lastRow; r++) for (let c = used.c1; c <= used.c2; c++) work.set(keyOf(r, c), null)
    }
    if (action.bodyStyle && hasBody) {
        for (let r = headerRow + 1; r <= lastRow; r++) for (let c = used.c1; c <= used.c2; c++) merge(r, c, action.bodyStyle)
    }
    for (const entry of action.columns || []) {
        if (entry.col < 0 || entry.col >= colCount || !hasBody) continue
        const c = used.c1 + entry.col
        for (let r = headerRow + 1; r <= lastRow; r++) merge(r, c, entry.style)
    }
    if (action.totalsStyle && totalsRow !== null) {
        for (let c = used.c1; c <= used.c2; c++) merge(totalsRow, c, action.totalsStyle)
    }
    if (action.headerStyle) {
        // Applied last so it wins; the header is never number-formatted.
        const header = withoutNumberFormat(action.headerStyle)
        for (let c = used.c1; c <= used.c2; c++) merge(headerRow, c, header)
    }

    const styles = []
    for (const [k, style] of work) {
        const row = Math.floor(k / 16384), col = k % 16384
        const after = compactStyle(style)
        if (!sameStyle(sheet.getStoredStyle(row, col), after)) styles.push({ row, col, style: after })
    }

    const widths = new Map()
    for (const w of action.columnWidths || []) {
        if (w.col < 0 || w.col >= colCount || w.width < MIN_WIDTH || w.width > MAX_WIDTH) continue
        widths.set(used.c1 + w.col, w.width)
    }
    if (action.autoFitColumns) {
        for (let c = used.c1; c <= used.c2; c++) {
            let widest = 0
            for (let r = headerRow; r <= lastRow; r++) {
                const style = { ...DEFAULT_STYLE, ...(current(r, c) || {}) }
                const text = formatValue(sheet.getValue(r, c), style.numberFormat)
                if (text) widest = Math.max(widest, measure(text, style))
            }
            widths.set(c, Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.ceil(widest + AUTOFIT_PADDING))))
        }
    }
    const colWidths = []
    for (const [col, width] of widths) if (sheet.getColWidth(col) !== width) colWidths.push({ col, width })

    const patch = { styles, colWidths }
    if (typeof action.freezeRows === 'number' && action.freezeRows !== sheet.frozen.rows) patch.freezeRows = action.freezeRows

    const changed = styles.length > 0 || colWidths.length > 0 || patch.freezeRows !== undefined
    return {
        result: changed ? 'OK' : 'NO_CHANGES',
        message: changed ? '' : droppedTotals
            ? 'The last row is not a totals row, so there was nothing to change.'
            : 'Nothing to change: the sheet already looks like that, or the request is outside the used range.',
        patch, totalsRow, droppedTotals,
    }
}
