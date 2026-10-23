import { describe, it, expect } from 'vitest'
import { extractJson } from './parse.js'
import { validateAction } from './validate.js'
import { ask } from './assistant.js'
import { createHttpProvider } from './provider.js'
import { executeQuery } from './executor.js'
import { describeQuery, describeFormat } from './describe.js'

const fake = (text) => ({ name: 'fake', complete: async () => ({ text, provider: 'fake' }) })
const context = { range: 'A1:B2', rowCount: 1, columns: [], sampleRows: [], selection: null, hasTotalsRow: false }

describe('response parsing', () => {
    it('finds JSON inside prose and fences, including braces in strings', () => {
        expect(extractJson('Sure! {"type":"clarify","question":"Use {Total}?"} hope that helps').value.question).toBe('Use {Total}?')
        expect(extractJson('```json\n{"type":"query"}\n```').value).toEqual({ type: 'query' })
        expect(extractJson('I think {maybe} this: {"type":"query"}').value).toEqual({ type: 'query' })
    })

    it('reports missing or broken JSON', () => {
        expect(extractJson('no json here').ok).toBe(false)
        expect(extractJson('{"type": "query",').ok).toBe(false)
        expect(extractJson('').ok).toBe(false)
    })
})

describe('validation', () => {
    it('says what failed', () => {
        const res = validateAction({ type: 'query', filters: [{ column: 'Region', op: 'like' }], limit: 0, extra: 1 })
        expect(res.ok).toBe(false)
        expect(res.error).toBe('INVALID_RESPONSE')
        const paths = res.details.map(d => d.path)
        expect(paths).toContain('$.filters[0].op')
        expect(paths).toContain('$.limit')
        expect(paths).toContain('$.extra')
    })

    it('rejects non-query/format/clarify actions as READ_ONLY', () => {
        expect(validateAction({ type: 'mutation', action: 'deleteRows' }).error).toBe('READ_ONLY')
        expect(validateAction({ type: 'format_sheet', freezeRows: null }).ok).toBe(true)
        expect(validateAction({ type: 'format_sheet', headerStyle: { bg: 'blue' } }).ok).toBe(false)
    })

    it('the executor refuses anything that is not a query', () => {
        expect(executeQuery({ type: 'format_sheet' }, { header: [], rows: [] }).error).toBe('READ_ONLY')
    })
})

describe('ask()', () => {
    it('turns provider failures into PROVIDER_ERROR', async () => {
        const res = await ask({ provider: { complete: async () => { throw Object.assign(new Error('Rate limited (429)'), { kind: 'rate_limit' }) } }, prompt: 'x', context })
        expect(res).toMatchObject({ ok: false, error: 'PROVIDER_ERROR' })
        expect(res.message).toContain('429')
    })

    it('turns prose without JSON into INVALID_RESPONSE', async () => {
        const res = await ask({ provider: fake('The answer is 42.'), prompt: 'x', context })
        expect(res).toMatchObject({ ok: false, error: 'INVALID_RESPONSE' })
    })

    it('http provider maps status codes to readable errors', async () => {
        const respond = (status, body) => async () => ({ ok: false, status, statusText: '', headers: new Map([['retry-after', '7']]), json: async () => body })
        const p401 = createHttpProvider({ apiKey: 'k', fetch: respond(401, { error: { message: 'invalid x-api-key' } }) })
        await expect(p401.complete({ system: '', user: 'u' })).rejects.toMatchObject({ kind: 'auth' })
        const p429 = createHttpProvider({ apiKey: 'k', fetch: respond(429, { error: { message: 'slow down' } }) })
        await expect(p429.complete({ system: '', user: 'u' })).rejects.toThrow(/retry after 7s/)
        const offline = createHttpProvider({ apiKey: 'k', fetch: async () => { throw new TypeError('Failed to fetch') } })
        await expect(offline.complete({ system: '', user: 'u' })).rejects.toMatchObject({ kind: 'network' })
        const noKey = createHttpProvider({ apiKey: '' })
        await expect(noKey.complete({ system: '', user: 'u' })).rejects.toMatchObject({ kind: 'auth' })
    })

    it('http provider sends system, history and user turn and joins text blocks', async () => {
        let sent
        const p = createHttpProvider({
            apiKey: 'k', model: 'm',
            fetch: async (url, init) => {
                sent = JSON.parse(init.body)
                return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"type":' }, { type: 'text', text: '"query"}' }] }) }
            },
        })
        const res = await p.complete({ system: 'S', user: 'U', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })
        expect(res.text).toBe('{"type":"query"}')
        expect(sent.system).toBe('S')
        expect(sent.model).toBe('m')
        expect(sent.messages.map(m => m.content)).toEqual(['a', 'b', 'U'])
    })
})

describe('descriptions', () => {
    it('describes plans in plain words', () => {
        expect(describeQuery({ type: 'query', filters: [{ column: 'Region', op: 'eq', value: 'West' }], groupBy: ['Sales Rep'], aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }], sort: [{ column: 'Sales', dir: 'desc' }], limit: 3 }))
            .toBe('Rows where Region is “West”, grouped by Sales Rep, sum of Total as “Sales”, sorted by Sales descending, top 3.')
        expect(describeFormat({ type: 'format_sheet', headerStyle: { bold: true, bg: '#f0f0f0' }, columns: [{ col: 6, style: { numberFormat: 'number' } }], freezeRows: 1, totalsStyle: { bold: true } }))
            .toBe('header: bold, grey background; 1 column (6): number formats; totals row: bold; freeze 1 row')
    })
})
