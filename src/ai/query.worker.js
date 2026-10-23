// Query executor worker: keeps the last posted table, runs plans on it.
import { executeQuery } from './executor.js'

let table = null
let tableVersion = null

self.onmessage = (e) => {
    const { id, plan, version } = e.data
    if (e.data.table) {
        table = e.data.table
        tableVersion = version
    }
    if (!table || tableVersion !== version) {
        self.postMessage({ id, error: 'Sheet data is out of date; run the query again.' })
        return
    }
    try {
        self.postMessage({ id, result: executeQuery(plan, table) })
    } catch (err) {
        self.postMessage({ id, error: err.message })
    }
}
