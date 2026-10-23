// The two "Sample" toolbar actions. Each load replaces the sheet and is one undo step.
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'
import { loadTsv } from './tsv.js'

export { parseTsv } from './tsv.js'

/** 33 lines: header, 31 messy data rows, totals row. */
export function loadSampleSmall(engine) {
    return loadTsv(engine, salesSmall)
}

/** ~3,000 lines of the same kind of data. */
export function loadSampleLarge(engine) {
    return loadTsv(engine, salesLarge)
}
