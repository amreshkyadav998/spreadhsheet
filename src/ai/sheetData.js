// ─────────────────────────────────────────────────────────────
//  Read the sheet into the plain table the executor and context
//  builder work on. This is the only place the AI code reads the
//  engine; everything downstream is a pure function of the table.
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {{ header: string[], rows: any[][], range: {r1,c1,r2,c2} | null }} SheetTable
 * header: row 1 of the used range; rows: every row below it (raw text
 * for literals, computed values for formulas). Blank rows are kept so
 * the executor applies the contract's skip rule itself.
 */

/** @returns {SheetTable} */
export function sheetTable(engine) {
    const range = engine.getUsedRange()
    if (!range) return { header: [], rows: [], range: null }
    const values = engine.getRangeValues(range)
    const header = values[0].map(v => (v === null || v === undefined ? '' : String(v)))
    return { header, rows: values.slice(1), range }
}
