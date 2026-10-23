// The "Sample" toolbar actions. Each load replaces the sheet and is one undo step.
// The fixtures are fetched on demand so they are not part of the first-paint bundle.
import { loadTsv, loadRows, generateRows } from './tsv.js'

export { parseTsv } from './tsv.js'

const smallText = () => import('../../fixtures/sales.tsv?raw').then(m => m.default)
const largeText = () => import('../../fixtures/sales-large.tsv?raw').then(m => m.default)

/** 33 lines: header, 31 messy data rows, totals row. */
export async function loadSampleSmall(engine) {
    return loadTsv(engine, await smallText())
}

/** ~3,000 lines of the same kind of data. */
export async function loadSampleLarge(engine) {
    return loadTsv(engine, await largeText())
}

/** 100,000 generated rows of the same shape (for the scale budgets). */
export async function loadSampleGenerated(engine, n = 100000) {
    return loadRows(engine, generateRows(await largeText(), n))
}
