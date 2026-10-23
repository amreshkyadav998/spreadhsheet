// Test helpers: load the fixture TSVs into an engine without Vite's ?raw imports.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../engine/core.js'
import { parseTsv, loadTsv } from '../fixtures/tsv.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

export function readFixture(name) {
    return readFileSync(root + 'fixtures/' + name, 'utf8')
}

export function readJson(name) {
    return JSON.parse(readFixture(name))
}

export function engineWith(name, rows = 200, cols = 30) {
    const engine = createEngine(rows, cols)
    loadTsv(engine, readFixture(name))
    return engine
}

export { parseTsv }
