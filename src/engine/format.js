// ─────────────────────────────────────────────────────────────
//  Cell styles and number formats. Pure.
//  Formatting is display-only: the stored raw value never changes.
// ─────────────────────────────────────────────────────────────

import { toNum, toDate } from './values.js'

export const DEFAULT_STYLE = Object.freeze({
    bold: false,
    italic: false,
    underline: false,
    bg: 'white',
    color: '#202124',
    align: 'left',
    fontSize: 13,
    numberFormat: 'general',
})

export const STYLE_KEYS = Object.freeze(Object.keys(DEFAULT_STYLE))

/** Drop keys that equal the default; returns null for an all-default style. */
export function compactStyle(style) {
    if (!style) return null
    let out = null
    for (const key of STYLE_KEYS) {
        if (style[key] !== undefined && style[key] !== DEFAULT_STYLE[key]) {
            if (!out) out = {}
            out[key] = style[key]
        }
    }
    return out
}

export function sameStyle(a, b) {
    for (const key of STYLE_KEYS) {
        const va = a && a[key] !== undefined ? a[key] : DEFAULT_STYLE[key]
        const vb = b && b[key] !== undefined ? b[key] : DEFAULT_STYLE[key]
        if (va !== vb) return false
    }
    return true
}

const twoDecimals = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** General display of a computed number: no float noise (0.1 + 0.2 → 0.3). */
export function formatGeneralNumber(n) {
    if (Number.isInteger(n)) return String(n)
    return String(parseFloat(n.toPrecision(12)))
}

function formatPercent(n) {
    const pct = Math.round(n * 100 * 100) / 100
    return `${formatGeneralNumber(pct)}%`
}

/**
 * Text shown in the grid for a computed value under a number format.
 * Non-numeric text is left alone by numeric formats, numbers are left
 * alone by the date format (AI_CONTRACT.md §4 display table).
 */
export function formatValue(value, numberFormat = 'general') {
    if (value === null || value === undefined || value === '') return ''
    if (numberFormat === 'general' || !numberFormat) {
        return typeof value === 'number' ? formatGeneralNumber(value) : String(value)
    }
    if (numberFormat === 'date') {
        if (typeof value === 'number') return formatGeneralNumber(value)
        return toDate(value) ?? String(value)
    }
    const n = toNum(value)
    if (n === null) return String(value)
    switch (numberFormat) {
        case 'number': return twoDecimals.format(n)
        case 'currency': return (n < 0 ? '-$' : '$') + twoDecimals.format(Math.abs(n))
        case 'percent': return formatPercent(n)
        default: return typeof value === 'number' ? formatGeneralNumber(value) : String(value)
    }
}
