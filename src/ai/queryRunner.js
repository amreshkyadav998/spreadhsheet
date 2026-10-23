// Runs the executor off the main thread for big sheets so the panel
// stays responsive. The table is posted once per sheet version and
// cached in the worker, so Re-run on an unchanged sheet copies nothing.
import { executeQuery } from './executor.js'

const WORKER_THRESHOLD = 20000

let worker = null
let seq = 0
let postedVersion = null
const pending = new Map()

function getWorker() {
    if (worker) return worker
    worker = new Worker(new URL('./query.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
        const { id, result, error } = e.data
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        if (error) p.reject(new Error(error))
        else p.resolve(result)
    }
    worker.onerror = (e) => {
        for (const p of pending.values()) p.reject(new Error(e.message || 'Query worker failed'))
        pending.clear()
        worker = null
        postedVersion = null
    }
    return worker
}

/**
 * @param {object} plan
 * @param {() => {header, rows}} getTable  called only when the worker needs the data
 * @param {{ version: number, rowCount: number }} sheet
 * @returns {Promise<object>} executor result
 */
export function runQuery(plan, getTable, sheet) {
    if (typeof Worker === 'undefined' || sheet.rowCount < WORKER_THRESHOLD) {
        return Promise.resolve(executeQuery(plan, getTable()))
    }
    const w = getWorker()
    const id = ++seq
    const message = { id, plan, version: sheet.version }
    if (postedVersion !== sheet.version) {
        message.table = getTable()
        postedVersion = sheet.version
    }
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        w.postMessage(message)
    })
}
