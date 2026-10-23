// ─────────────────────────────────────────────────────────────
//  Sort ordering. Pure.
//  Numbers before dates before text, blanks last in both
//  directions, text case-insensitive, ties keep their order.
// ─────────────────────────────────────────────────────────────

import { classify } from './values.js'

const RANK = { number: 0, date: 1, text: 2, blank: 3 }

/** Decorate a computed value once so the comparator stays cheap. */
export function sortKey(value) {
    const c = classify(value)
    return { rank: RANK[c.kind], num: c.num, text: c.text }
}

/**
 * @param {{rank,num,text}} a
 * @param {{rank,num,text}} b
 * @param {1|-1} sign  1 ascending, -1 descending
 */
export function compareKeys(a, b, sign) {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.rank === RANK.blank) return 0
    if (a.rank === RANK.text) return a.text < b.text ? -sign : a.text > b.text ? sign : 0
    return (a.num - b.num) * sign
}

/**
 * Order rows by one column.
 * @param {number[]} rows      row indexes to order
 * @param {(row:number)=>any} valueOf  computed value of the sort column
 * @param {'asc'|'desc'} dir
 * @param {(row:number)=>boolean} [isEmptyRow]  fully empty rows always go last
 * @returns {number[]} the same rows in sorted order (stable)
 */
export function orderRows(rows, valueOf, dir, isEmptyRow = () => false) {
    const sign = dir === 'desc' ? -1 : 1
    const items = rows.map((row, i) => ({ row, i, empty: isEmptyRow(row), key: sortKey(valueOf(row)) }))
    items.sort((a, b) => {
        if (a.empty !== b.empty) return a.empty ? 1 : -1
        return compareKeys(a.key, b.key, sign) || a.i - b.i
    })
    return items.map(it => it.row)
}
