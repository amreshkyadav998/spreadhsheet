// ─────────────────────────────────────────────────────────────
//  Plain-words descriptions of actions, built from the validated
//  JSON only (no model prose is ever shown as an explanation).
// ─────────────────────────────────────────────────────────────

const OP_WORDS = {
    eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤',
    contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
    isEmpty: 'is empty', notEmpty: 'is not empty',
}
const FN_WORDS = { sum: 'sum', avg: 'average', count: 'count', countDistinct: 'distinct count', min: 'minimum', max: 'maximum' }
const COLOUR_WORDS = {
    '#f0f0f0': 'grey', '#cce5ff': 'blue', '#ffff99': 'yellow', '#99ffcc': 'green',
    '#ffcccc': 'red', '#e0ccff': 'purple', '#ffd9b3': 'orange', white: 'white',
}

const q = (s) => `“${s}”`

/** "Rows where Region is West, grouped by Region: sum of Total as “Total Sales”, sorted by …, top 3." */
export function describeQuery(plan) {
    const parts = []
    const filters = (plan.filters || []).map(f =>
        f.op === 'isEmpty' || f.op === 'notEmpty' ? `${f.column} ${OP_WORDS[f.op]}` : `${f.column} ${OP_WORDS[f.op] || f.op} ${q(f.value)}`)
    parts.push(filters.length ? `Rows where ${filters.join(' and ')}` : 'All rows')
    if (plan.excludeTotalsRow === false) parts[0] += ' (including the totals row)'
    if (plan.groupBy && plan.groupBy.length) parts.push(`grouped by ${plan.groupBy.join(' and ')}`)
    if (plan.aggregates && plan.aggregates.length) {
        parts.push(plan.aggregates.map(a => `${FN_WORDS[a.fn] || a.fn} of ${a.column}${a.as ? ` as ${q(a.as)}` : ''}`).join(', '))
    } else if (plan.columns && plan.columns.length && !(plan.groupBy && plan.groupBy.length)) {
        parts.push(`showing ${plan.columns.join(', ')}`)
    }
    if (plan.sort && plan.sort.length) {
        parts.push(`sorted by ${plan.sort.map(s => `${s.column} ${s.dir === 'desc' ? 'descending' : 'ascending'}`).join(', then ')}`)
    }
    if (plan.limit) parts.push(plan.limit > 500 ? `limit ${plan.limit} (capped at 500)` : `top ${plan.limit}`)
    return parts.join(', ') + '.'
}

function styleWords(style) {
    const words = []
    if (style.bold) words.push('bold')
    if (style.bold === false) words.push('not bold')
    if (style.italic) words.push('italic')
    if (style.underline) words.push('underlined')
    if (style.bg) words.push(`${COLOUR_WORDS[style.bg.toLowerCase()] || style.bg} background`)
    if (style.color) words.push(`${COLOUR_WORDS[style.color.toLowerCase()] || style.color} text`)
    if (style.align) words.push(style.align === 'center' ? 'centred' : `${style.align}-aligned`)
    if (style.fontSize) words.push(`${style.fontSize}px`)
    if (style.numberFormat) words.push(`${style.numberFormat} format`)
    return words.join(', ')
}

/** "header: bold, grey background, centred; 4 columns: number formats; freeze 1 row; totals row: bold" */
export function describeFormat(action) {
    const parts = []
    if (action.clearFormatting) parts.push('clear all formatting first')
    if (action.headerStyle) parts.push(`header: ${styleWords(action.headerStyle)}`)
    if (action.bodyStyle) parts.push(`body: ${styleWords(action.bodyStyle)}`)
    const cols = action.columns || []
    if (cols.length) {
        const formats = cols.filter(c => c.style.numberFormat).length
        const label = formats === cols.length ? 'number formats' : formats ? 'number formats and styles' : cols.map(c => styleWords(c.style)).filter((v, i, a) => a.indexOf(v) === i).join('; ')
        parts.push(`${cols.length} column${cols.length === 1 ? '' : 's'} (${cols.map(c => c.col).join(', ')}): ${label}`)
    }
    if (action.totalsStyle) parts.push(`totals row: ${styleWords(action.totalsStyle)}`)
    if (typeof action.freezeRows === 'number') parts.push(action.freezeRows === 0 ? 'unfreeze rows' : `freeze ${action.freezeRows} row${action.freezeRows === 1 ? '' : 's'}`)
    if (action.columnWidths && action.columnWidths.length) parts.push(`${action.columnWidths.length} column width${action.columnWidths.length === 1 ? '' : 's'}`)
    if (action.autoFitColumns) parts.push('auto-fit column widths')
    return parts.length ? parts.join('; ') : 'no formatting changes'
}
