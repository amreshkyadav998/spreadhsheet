// ─────────────────────────────────────────────────────────────
//  Ctrl+K assistant panel. The model only translates: every number
//  shown here comes from the executor or the engine.
// ─────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react'
import { ask } from '../ai/assistant.js'
import { sheetTable } from '../ai/sheetData.js'
import { buildContext } from '../ai/context.js'
import { runQuery } from '../ai/queryRunner.js'
import { roundForDisplay } from '../ai/executor.js'
import { planFormat } from '../ai/formatApplier.js'
import { describeQuery, describeFormat } from '../ai/describe.js'
import { cellName, parseCellName } from '../engine/formula.js'
import { formatGeneralNumber } from '../engine/format.js'
import { measureText } from './measure.js'
import { createProvider } from '../ai/provider.js'
import queries from '../../fixtures/ai-eval/queries.json'
import formats from '../../fixtures/ai-eval/format-prompts.json'

const EXAMPLES = [
    ...queries.cases.map(c => ({ group: 'Ask (sales-large.tsv)', prompt: c.prompt })),
    ...formats.cases.map(c => ({ group: 'Format (sales.tsv)', prompt: c.prompt })),
]
const SHOWN_ROWS = 200
let nextId = 1
// One provider for the session; the panel's conversation survives in the cards.
const provider = createProvider()

const show = (v) => {
    const r = roundForDisplay(v)
    if (r === null || r === undefined) return '—'
    return typeof r === 'number' ? formatGeneralNumber(r) : String(r)
}

function defaultInsertCell(engine) {
    const used = engine.getUsedRange()
    return cellName(used ? used.r1 : 0, used ? used.c2 + 2 : 0)
}

function ResultTable({ result }) {
    return (
        <div className="result-table-wrap">
            <table className="result-table">
                <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>
                    {result.rows.slice(0, SHOWN_ROWS).map((row, i) => (
                        <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === 'number' ? 'num' : ''}>{show(v)}</td>)}</tr>
                    ))}
                </tbody>
            </table>
            {result.rows.length > SHOWN_ROWS && <div className="muted">Showing {SHOWN_ROWS} of {result.rowCount} rows; Insert writes all of them.</div>}
        </div>
    )
}

function Card({ card, showPlans, onRerun, onInsert, onApply, onDiscard, onTogglePlan }) {
    const [insertAt, setInsertAt] = useState(card.insertAt)
    const r = card.response
    const planVisible = showPlans || card.showPlan
    const action = r && r.ok ? r.action : null
    return (
        <div className={`ai-card ${card.kind}`}>
            <div className="ai-prompt">{card.prompt}</div>
            {card.status === 'pending' && <div className="muted">Thinking…</div>}
            {card.kind === 'error' && (
                <div className="ai-error">
                    <strong>{card.error}</strong> {card.message}
                    {r && r.details && <ul>{r.details.slice(0, 6).map((d, i) => <li key={i}><code>{d.path}</code> {d.message}</li>)}</ul>}
                    <div className="muted">Nothing in the sheet was changed.</div>
                </div>
            )}
            {card.kind === 'clarify' && <div className="ai-clarify">❓ {card.question}</div>}
            {card.kind === 'query' && card.result && (
                <>
                    <div className="ai-desc">{describeQuery(action)}</div>
                    <ResultTable result={card.result} />
                    <div className="ai-meta">
                        {card.result.rowCount} row{card.result.rowCount === 1 ? '' : 's'}{card.result.truncated ? ' (truncated to the limit)' : ''} · executed in {card.ms.toFixed(1)} ms
                    </div>
                    <div className="ai-actions">
                        <button onClick={() => onRerun(card)} title="Run the same plan again on the current sheet, no model call">Re-run</button>
                        <span className="insert">
                            Insert at <input value={insertAt} size={6} onChange={(e) => setInsertAt(e.target.value)} />
                            <button onClick={() => onInsert(card, insertAt)}>Insert into sheet</button>
                        </span>
                    </div>
                    {card.note && <div className="ai-note">{card.note}</div>}
                </>
            )}
            {card.kind === 'format' && (
                <>
                    <div className="ai-desc">Preview: {describeFormat(action)}</div>
                    {card.outcome.result !== 'OK' && (
                        <div className={card.outcome.result === 'OUT_OF_RANGE' ? 'ai-error' : 'ai-note'}>
                            <strong>{card.outcome.result}</strong> {card.outcome.message}
                        </div>
                    )}
                    {card.outcome.result === 'OK' && card.outcome.droppedTotals && <div className="ai-note">The last row is not a totals row, so the totals style is skipped.</div>}
                    {card.outcome.result === 'OK' && !card.applied && !card.discarded && (
                        <div className="ai-actions">
                            <button className="primary" onClick={() => onApply(card)}>Apply</button>
                            <button onClick={() => onDiscard(card)}>Discard</button>
                        </div>
                    )}
                    {card.note && <div className="ai-note">{card.note}</div>}
                </>
            )}
            {r && r.raw !== undefined && (
                <div className="ai-plan-toggle">
                    <button className="link" onClick={() => onTogglePlan(card)}>{planVisible ? 'Hide plan' : 'Show plan'}</button>
                    {planVisible && <pre className="ai-plan">{action ? JSON.stringify(action, null, 2) : r.raw}</pre>}
                </div>
            )}
        </div>
    )
}

export default function AiPanel({ engine, selection, onClose }) {
    const [cards, setCards] = useState([])
    const [prompt, setPrompt] = useState('')
    const [busy, setBusy] = useState(false)
    const [showPlans, setShowPlans] = useState(false)
    const listRef = useRef(null)

    const update = useCallback((id, patch) => setCards(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c))), [])

    const execute = useCallback(async (id, action) => {
        const t0 = performance.now()
        const used = engine.getUsedRange()
        const rowCount = used ? used.r2 - used.r1 : 0
        try {
            const result = await runQuery(action, () => sheetTable(engine), { version: engine.version, rowCount })
            const ms = performance.now() - t0
            if (result.error === 'UNKNOWN_COLUMN') {
                const name = result.detail.slice('UNKNOWN_COLUMN:'.length)
                const cols = sheetTable(engine).header.filter(Boolean).join(', ')
                update(id, { kind: 'clarify', question: `There is no column called “${name}”. Which column did you mean? Available: ${cols}.` })
            } else if (result.error) {
                update(id, { kind: 'error', error: result.error, message: result.detail })
            } else {
                update(id, { kind: 'query', result, ms, note: null })
            }
        } catch (e) {
            update(id, { kind: 'error', error: 'EXECUTION_ERROR', message: e.message })
        }
    }, [engine, update])

    const submit = useCallback(async (text) => {
        const p = text.trim()
        if (!p || busy) return
        const id = nextId++
        const history = []
        for (const c of cards) {
            if (c.response && c.response.raw !== undefined) history.push({ role: 'user', content: c.prompt }, { role: 'assistant', content: c.response.raw })
        }
        setCards(cs => [...cs, { id, prompt: p, status: 'pending', kind: 'pending', insertAt: defaultInsertCell(engine) }])
        setPrompt('')
        setBusy(true)
        const context = buildContext(sheetTable(engine), selection)
        const response = await ask({ provider, prompt: p, context, history })
        setBusy(false)
        update(id, { status: 'done', response })
        if (!response.ok) {
            update(id, { kind: 'error', error: response.error, message: response.message })
        } else if (response.action.type === 'clarify') {
            update(id, { kind: 'clarify', question: response.action.question })
        } else if (response.action.type === 'query') {
            await execute(id, response.action)
        } else if (response.action.type === 'format_sheet') {
            const outcome = planFormat(response.action, engine, { measureText })
            update(id, { kind: 'format', outcome })
        }
        requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
    }, [busy, cards, engine, selection, update, execute])

    const onRerun = useCallback((card) => execute(card.id, card.response.action), [execute])

    const onInsert = useCallback((card, at) => {
        const pos = parseCellName(at)
        if (!pos) {
            update(card.id, { note: `“${at}” is not a cell address.` })
            return
        }
        const matrix = [card.result.columns, ...card.result.rows.map(row => row.map(v => {
            const r = roundForDisplay(v)
            return r === null || r === undefined ? '' : String(r)
        }))]
        engine.ensureCapacity(pos.row + matrix.length, pos.col + matrix[0].length)
        engine.writeBlock(pos.row, pos.col, matrix, 'Insert query result')
        update(card.id, { note: `Inserted ${matrix.length - 1} rows at ${at.toUpperCase()}. Ctrl+Z removes them in one step.` })
    }, [engine, update])

    const onApply = useCallback((card) => {
        const t0 = performance.now()
        const outcome = planFormat(card.response.action, engine, { measureText })
        if (outcome.result !== 'OK') {
            update(card.id, { outcome })
            return
        }
        engine.applyFormatPatch(outcome.patch, 'AI format')
        const ms = performance.now() - t0
        update(card.id, { applied: true, note: `Applied in ${ms.toFixed(1)} ms (${outcome.patch.styles.length} cell styles). Ctrl+Z reverts it in one step.` })
    }, [engine, update])

    const onDiscard = useCallback((card) => update(card.id, { discarded: true, note: 'Discarded. Nothing was changed.' }), [update])
    const onTogglePlan = useCallback((card) => update(card.id, { showPlan: !card.showPlan }), [update])

    return (
        <aside className="ai-panel" aria-label="Assistant">
            <div className="ai-head">
                <strong>Assistant</strong>
                <span className="muted">provider: {provider.name}</span>
                <label className="ai-showplan"><input type="checkbox" checked={showPlans} onChange={(e) => setShowPlans(e.target.checked)} /> show plan</label>
                <button className="link" onClick={onClose} title="Close (Esc)">✕</button>
            </div>
            <div className="ai-list" ref={listRef}>
                {cards.length === 0 && (
                    <div className="muted ai-empty">
                        Ask a question about the sheet (“What is the total sales by region?”) or ask for formatting (“Format this as a clean table”). The model returns a plan; the app validates it and computes every number.
                    </div>
                )}
                {cards.map(card => (
                    <Card key={card.id} card={card} showPlans={showPlans} onRerun={onRerun} onInsert={onInsert} onApply={onApply} onDiscard={onDiscard} onTogglePlan={onTogglePlan} />
                ))}
            </div>
            <form className="ai-input" onSubmit={(e) => { e.preventDefault(); submit(prompt) }}>
                <select value="" onChange={(e) => { if (e.target.value) setPrompt(e.target.value) }} title="Golden-set prompts">
                    <option value="">Examples…</option>
                    {['Ask (sales-large.tsv)', 'Format (sales.tsv)'].map(g => (
                        <optgroup key={g} label={g}>
                            {EXAMPLES.filter(x => x.group === g).map(x => <option key={x.prompt} value={x.prompt}>{x.prompt}</option>)}
                        </optgroup>
                    ))}
                </select>
                <textarea
                    autoFocus
                    rows={2}
                    value={prompt}
                    placeholder="Ask or format… (Enter to send)"
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(prompt) }
                        if (e.key === 'Escape') onClose()
                    }}
                />
                <button type="submit" className="primary" disabled={busy || !prompt.trim()}>{busy ? '…' : 'Send'}</button>
            </form>
        </aside>
    )
}
