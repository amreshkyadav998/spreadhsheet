// TSV import shared by the toolbar loaders, the tests and the benchmarks.

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

/** Replace the sheet's contents with a 2-D array at A1, as one undo step. */
export function loadRows(engine, rows) {
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    engine.batch('Load sample', () => {
        engine.clearAll()
        engine.writeBlock(0, 0, rows)
    })
    return { rows: rows.length, cols }
}

export function loadTsv(engine, text) {
    return loadRows(engine, parseTsv(text))
}

/**
 * n data rows shaped like `text` (header kept, totals row dropped), with
 * unique order ids. Deterministic, for the 100k-row benchmarks.
 */
export function generateRows(text, n) {
    const rows = parseTsv(text)
    const header = rows[0]
    const body = rows.slice(1, -1).filter(r => r.some(v => v.trim() !== ''))
    const out = [header]
    for (let i = 0; i < n; i++) {
        const row = body[i % body.length].slice()
        row[0] = `ORD-${100000 + i}`
        out.push(row)
    }
    return out
}
