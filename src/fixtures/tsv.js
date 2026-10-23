// TSV import shared by the toolbar loaders and the tests.

export function parseTsv(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.map(line => line.split('\t'))
}

/** Replace the sheet's contents with a TSV at A1, as one undo step. */
export function loadTsv(engine, text) {
    const rows = parseTsv(text)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    engine.batch('Load sample', () => {
        engine.clearAll()
        engine.writeBlock(0, 0, rows)
    })
    return { rows: rows.length, cols }
}
