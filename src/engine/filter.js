// ─────────────────────────────────────────────────────────────
//  Column filters. Pure. A filter is a view: it decides which
//  rows are hidden and never touches cell data.
//
//  ColumnFilter = {
//    values: string[] | null   allowed normalised values ('' = blanks); null = all
//    cond:   { op: 'contains'|'gt'|'lt'|'isEmpty', value?: string } | null
//  }
//  Several columns combine with AND; inside one column values AND cond.
// ─────────────────────────────────────────────────────────────

import { norm, toNum, toDate, isBlank } from './values.js'

export const FILTER_CONDITIONS = Object.freeze(['contains', 'gt', 'lt', 'isEmpty'])

export function isActiveFilter(f) {
    return !!f && (Array.isArray(f.values) || !!f.cond)
}

function compareOrdered(cell, target, op) {
    const targetDate = toDate(target)
    let a, b
    if (targetDate) {
        a = toDate(cell)
        b = targetDate
        if (a === null) return false
    } else {
        a = toNum(cell)
        b = toNum(target)
        if (a === null || b === null) return false
    }
    return op === 'gt' ? a > b : a < b
}

export function matchesCondition(value, cond) {
    if (!cond) return true
    switch (cond.op) {
        case 'contains': return norm(value).includes(norm(cond.value))
        case 'gt':
        case 'lt': return compareOrdered(value, cond.value, cond.op)
        case 'isEmpty': return isBlank(value)
        default: return true
    }
}

export function matchesFilter(value, filter) {
    if (!filter) return true
    if (Array.isArray(filter.values) && !filter.values.includes(norm(value))) return false
    return matchesCondition(value, filter.cond)
}

/**
 * Distinct values of a column for the filter checklist, grouped by
 * normalised text so "West", "West " and "west" are one entry.
 * @returns {{ key:string, label:string, count:number }[]}  blanks last, labelled "(Blanks)"
 */
export function distinctValues(values) {
    const groups = new Map()
    for (const v of values) {
        const key = norm(v)
        const g = groups.get(key)
        if (g) g.count++
        else groups.set(key, { key, label: key === '' ? '(Blanks)' : String(v).trim(), count: 1 })
    }
    const list = [...groups.values()]
    list.sort((a, b) => {
        if (a.key === '') return 1
        if (b.key === '') return -1
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })
    return list
}
