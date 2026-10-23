import { Profiler, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { parseRangeName } from './engine/formula.js'
import { toNum } from './engine/values.js'
import { formatGeneralNumber } from './engine/format.js'
import { loadSampleSmall, loadSampleLarge, loadSampleGenerated } from './fixtures/loadSample.js'
import { parseTsv } from './fixtures/tsv.js'
import Grid from './ui/Grid.jsx'
import FilterMenu from './ui/FilterMenu.jsx'
import { NameBox, FormulaInput } from './ui/FormulaBar.jsx'
import { createStore, useEngineVersion } from './ui/stores.js'
import { measureText } from './ui/measure.js'

// The assistant (and the mock provider's golden prompts) load on first Ctrl+K.
const AiPanel = lazy(() => import('./ui/AiPanel.jsx'))

const GRID_ROWS = 100000
const GRID_COLS = 200
const FILLS = [
    ['white', 'None'], ['#ffff99', 'Yellow'], ['#99ffcc', 'Green'], ['#ffcccc', 'Red'],
    ['#cce5ff', 'Blue'], ['#e0ccff', 'Purple'], ['#ffd9b3', 'Orange'], ['#f0f0f0', 'Grey'],
]
const SUMMARY_LIMIT = 200000

const DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')

// With ?debug, count React commits per subtree (needs `npm run build:profile`
// in production; the dev server always reports). Read window.__commits.
function countCommit(id, phase, actualDuration) {
    const stats = (window.__commits ??= {})
    const s = (stats[id] ??= { commits: 0, ms: 0 })
    s.commits++
    s.ms += actualDuration
}

const rangeOf = (sel) => ({
    r1: Math.min(sel.anchor.r, sel.focus.r), c1: Math.min(sel.anchor.c, sel.focus.c),
    r2: Math.max(sel.anchor.r, sel.focus.r), c2: Math.max(sel.anchor.c, sel.focus.c),
})
const single = (r, c) => ({ anchor: { r, c }, focus: { r, c } })

export default function App() {
    const [engine] = useState(() => createEngine(GRID_ROWS, GRID_COLS))
    const version = useEngineVersion(engine)
    const [editStore] = useState(() => createStore(''))
    const [selection, setSelection] = useState(() => single(0, 0))
    const [editing, setEditing] = useState(null)
    const [filterMenu, setFilterMenu] = useState(null)
    const [aiOpen, setAiOpen] = useState(false)
    const [perf, setPerf] = useState(null)
    const gridRef = useRef(null)
    const editingRef = useRef(null)

    const range = useMemo(() => rangeOf(selection), [selection])
    const active = selection.anchor

    // ── Timing: engine time, then time until the next frame is painted ──
    // Async work (sample loads) is timed until its promise settles.
    const timed = useCallback((label, fn) => {
        const t0 = performance.now()
        const report = () => {
            const engineMs = performance.now() - t0
            requestAnimationFrame(() => setTimeout(() => setPerf({ label, engineMs, paintMs: performance.now() - t0 }), 0))
        }
        const result = fn()
        if (result && typeof result.then === 'function') result.then(report)
        else report()
        return result
    }, [])

    // ── Editing ──
    const setEditingState = useCallback((next) => {
        editingRef.current = next
        setEditing(next)
    }, [])

    const startEdit = useCallback((r, c, { mode = 'edit', initial, focusCell = true } = {}) => {
        editStore.set(initial ?? engine.getRaw(r, c))
        setSelection(s => (s.anchor.r === r && s.anchor.c === c && s.focus.r === r && s.focus.c === c ? s : single(r, c)))
        setEditingState({ r, c, mode, focusCell })
        gridRef.current?.scrollIntoView(r, c)
    }, [editStore, engine, setEditingState])

    const moveTo = useCallback((r, c, extend = false) => {
        const rr = Math.max(0, Math.min(engine.rows - 1, r))
        const cc = Math.max(0, Math.min(engine.cols - 1, c))
        setSelection(s => (extend ? { anchor: s.anchor, focus: { r: rr, c: cc } } : single(rr, cc)))
        gridRef.current?.scrollIntoView(rr, cc)
    }, [engine])

    /** Step from (r, c) by (dr, dc), skipping rows hidden by a filter. */
    const stepFrom = useCallback((r, c, dr, dc) => {
        const axis = gridRef.current?.rowAxis
        const nr = dr && axis ? axis.step(r, dr) : r + dr
        return { r: nr, c: c + dc }
    }, [])

    const commitEdit = useCallback((dr = 0, dc = 0) => {
        const ed = editingRef.current
        if (!ed) return
        const text = editStore.get()
        if (text !== engine.getRaw(ed.r, ed.c)) timed('Edit', () => engine.setCell(ed.r, ed.c, text))
        setEditingState(null)
        if (dr || dc) {
            const next = stepFrom(ed.r, ed.c, dr, dc)
            moveTo(next.r, next.c)
        }
        gridRef.current?.focus()
    }, [editStore, engine, setEditingState, moveTo, stepFrom, timed])

    const cancelEdit = useCallback(() => {
        setEditingState(null)
        gridRef.current?.focus()
    }, [setEditingState])

    const onEditorKeyDown = useCallback((e) => {
        const ed = editingRef.current
        if (!ed) return
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0) }
        else if (e.key === 'Tab') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1) }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
        else if (ed.mode === 'enter' && e.key.startsWith('Arrow')) {
            e.preventDefault()
            const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
            commitEdit(d[0], d[1])
        } else if (e.key === 'F2') {
            setEditingState({ ...ed, mode: ed.mode === 'enter' ? 'edit' : 'enter' })
        }
    }, [commitEdit, cancelEdit, setEditingState])

    // ── Commands on the selection ──
    const activeStyle = engine.getStyle(active.r, active.c)
    const applyStyle = useCallback((patch, label = 'Format') => timed(label, () => engine.setStyle(range, patch)), [engine, range, timed])

    const fillDown = useCallback((axis) => {
        if (axis === 'down' && range.r2 > range.r1) {
            timed('Fill down', () => engine.fill({ r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c2 }, range, { copy: true }))
        } else if (axis === 'right' && range.c2 > range.c1) {
            timed('Fill right', () => engine.fill({ r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c1 }, range, { copy: true }))
        }
    }, [engine, range, timed])

    const onFill = useCallback((source, target) => {
        timed('Fill', () => engine.fill(source, target))
        setSelection({ anchor: { r: target.r1, c: target.c1 }, focus: { r: target.r2, c: target.c2 } })
    }, [engine, timed])

    const onSort = useCallback((col) => {
        timed('Sort', () => engine.cycleSort(col, range))
    }, [engine, range, timed])

    const autoFit = useCallback((col) => {
        const used = engine.getUsedRange()
        let widest = 0
        if (used) {
            for (let r = used.r1; r <= used.r2; r++) {
                const text = engine.getDisplay(r, col)
                if (text !== '') widest = Math.max(widest, measureText(text, engine.getStyle(r, col)))
            }
        }
        timed('Auto-fit', () => engine.setColWidth(col, Math.max(30, Math.min(600, Math.ceil(widest + 16)))))
    }, [engine, timed])

    const jumpEdge = useCallback((r, c, dr, dc) => {
        const filled = (rr, cc) => engine.getRaw(rr, cc) !== ''
        const inside = (rr, cc) => rr >= 0 && cc >= 0 && rr < engine.rows && cc < engine.cols
        let rr = r + dr, cc = c + dc
        if (!inside(rr, cc)) return { r, c }
        if (filled(r, c) && filled(rr, cc)) {
            while (inside(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) { rr += dr; cc += dc }
        } else {
            while (inside(rr, cc) && !filled(rr, cc)) { rr += dr; cc += dc }
            if (!inside(rr, cc)) { rr -= dr; cc -= dc }
        }
        return { r: rr, c: cc }
    }, [engine])

    const onGridKeyDown = useCallback((e) => {
        if (editingRef.current) return
        const mod = e.ctrlKey || e.metaKey
        const k = e.key
        const from = e.shiftKey ? selection.focus : selection.anchor
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
        if (mod) {
            const lower = k.toLowerCase()
            if (lower === 'z') { e.preventDefault(); timed(e.shiftKey ? 'Redo' : 'Undo', () => (e.shiftKey ? engine.redo() : engine.undo())) }
            else if (lower === 'y') { e.preventDefault(); timed('Redo', () => engine.redo()) }
            else if (lower === 'a') {
                e.preventDefault()
                const used = engine.getUsedRange()
                setSelection(used ? { anchor: { r: used.r1, c: used.c1 }, focus: { r: used.r2, c: used.c2 } } : single(0, 0))
            } else if (lower === 'b') { e.preventDefault(); applyStyle({ bold: !activeStyle.bold }) }
            else if (lower === 'i') { e.preventDefault(); applyStyle({ italic: !activeStyle.italic }) }
            else if (lower === 'u') { e.preventDefault(); applyStyle({ underline: !activeStyle.underline }) }
            else if (lower === 'd') { e.preventDefault(); fillDown('down') }
            else if (lower === 'r') { e.preventDefault(); fillDown('right') }
            else if (k === 'Home') { e.preventDefault(); moveTo(0, 0, e.shiftKey) }
            else if (k === 'End') {
                e.preventDefault()
                const used = engine.getUsedRange()
                moveTo(used ? used.r2 : 0, used ? used.c2 : 0, e.shiftKey)
            } else if (arrows[k]) {
                e.preventDefault()
                const t = jumpEdge(from.r, from.c, arrows[k][0], arrows[k][1])
                moveTo(t.r, t.c, e.shiftKey)
            }
            return
        }
        if (arrows[k]) {
            e.preventDefault()
            const t = stepFrom(from.r, from.c, arrows[k][0], arrows[k][1])
            moveTo(t.r, t.c, e.shiftKey)
        } else if (k === 'PageDown' || k === 'PageUp') {
            e.preventDefault()
            const n = gridRef.current?.pageRows() ?? 20
            const t = stepFrom(from.r, from.c, k === 'PageDown' ? n : -n, 0)
            moveTo(t.r, t.c, e.shiftKey)
        } else if (k === 'Home') {
            e.preventDefault()
            moveTo(from.r, 0, e.shiftKey)
        } else if (k === 'Tab') {
            e.preventDefault()
            moveTo(active.r, active.c + (e.shiftKey ? -1 : 1))
        } else if (k === 'Enter' || k === 'F2') {
            e.preventDefault()
            startEdit(active.r, active.c, { mode: 'edit' })
        } else if (k === 'Delete' || k === 'Backspace') {
            e.preventDefault()
            timed('Clear', () => engine.clearContents(range))
        } else if (k.length === 1 && !e.altKey) {
            e.preventDefault()
            startEdit(active.r, active.c, { mode: 'enter', initial: k })
        }
    }, [selection, active, range, engine, activeStyle, applyStyle, fillDown, moveTo, jumpEdge, stepFrom, startEdit, timed])

    // ── Clipboard (TSV of displayed text; paste writes one undo step) ──
    const onCopy = useCallback((e) => {
        if (editingRef.current) return
        const cells = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
        if (cells > 100000) return
        const lines = []
        for (let r = range.r1; r <= range.r2; r++) {
            const line = []
            for (let c = range.c1; c <= range.c2; c++) line.push(engine.getDisplay(r, c))
            lines.push(line.join('\t'))
        }
        e.clipboardData.setData('text/plain', lines.join('\n'))
        e.preventDefault()
    }, [engine, range])

    const onPaste = useCallback((e) => {
        if (editingRef.current) return
        const text = e.clipboardData.getData('text/plain')
        if (!text) return
        e.preventDefault()
        timed('Paste', () => engine.writeBlock(active.r, active.c, parseTsv(text), 'Paste'))
    }, [engine, active, timed])

    // ?debug exposes the engine to the console for measurements and checks.
    useEffect(() => {
        if (DEBUG) window.__engine = engine
    }, [engine])

    // ── Global shortcuts ──
    useEffect(() => {
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                setAiOpen(open => !open)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    const jump = useCallback((text) => {
        const rg = parseRangeName(text)
        if (!rg || rg.r2 >= engine.rows || rg.c2 >= engine.cols) return false
        setSelection({ anchor: { r: rg.r1, c: rg.c1 }, focus: { r: rg.r2, c: rg.c2 } })
        gridRef.current?.scrollIntoView(rg.r1, rg.c1)
        gridRef.current?.focus()
        return true
    }, [engine])

    const loadSample = useCallback(async (label, loader) => {
        setEditingState(null)
        await timed(label, () => loader(engine))
        setSelection(single(0, 0))
        gridRef.current?.scrollIntoView(0, 0)
        gridRef.current?.focus()
    }, [engine, setEditingState, timed])

    const structural = useCallback((kind) => {
        const rows = range.r2 - range.r1 + 1
        const cols = range.c2 - range.c1 + 1
        const wholeRows = range.c1 === 0 && range.c2 === engine.cols - 1
        const wholeCols = range.r1 === 0 && range.r2 === engine.rows - 1
        timed(kind, () => {
            if (kind === 'Insert row') engine.insertRow(range.r1, wholeRows ? rows : 1)
            if (kind === 'Delete row') engine.deleteRow(range.r1, rows)
            if (kind === 'Insert column') engine.insertColumn(range.c1, wholeCols ? cols : 1)
            if (kind === 'Delete column') engine.deleteColumn(range.c1, cols)
        })
    }, [engine, range, timed])

    // ── Status ──
    const filterStatus = engine.getFilterStatus()
    const summary = useMemo(() => {
        void version
        const cells = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
        if (cells < 2 || cells > SUMMARY_LIMIT) return null
        const used = engine.getUsedRange()
        if (!used) return null
        let count = 0, sum = 0, nums = 0
        for (let r = range.r1; r <= Math.min(range.r2, used.r2); r++) {
            for (let c = range.c1; c <= Math.min(range.c2, used.c2); c++) {
                const v = engine.getValue(r, c)
                if (v === '') continue
                count++
                const n = typeof v === 'number' ? v : toNum(v)
                if (n !== null) { nums++; sum += n }
            }
        }
        return { count, sum, nums }
    }, [engine, range, version])

    const frozenKey = `${engine.frozen.rows},${engine.frozen.cols}`

    return (
        <div className="app">
            <header className="toolbar">
                <div className="tb-group">
                    <button className={activeStyle.bold ? 'on' : ''} onClick={() => applyStyle({ bold: !activeStyle.bold })} title="Bold (Ctrl+B)"><b>B</b></button>
                    <button className={activeStyle.italic ? 'on' : ''} onClick={() => applyStyle({ italic: !activeStyle.italic })} title="Italic (Ctrl+I)"><i>I</i></button>
                    <button className={activeStyle.underline ? 'on' : ''} onClick={() => applyStyle({ underline: !activeStyle.underline })} title="Underline (Ctrl+U)"><u>U</u></button>
                    <select value={activeStyle.fontSize} onChange={(e) => applyStyle({ fontSize: parseInt(e.target.value, 10) })} title="Font size">
                        {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
                <div className="tb-group">
                    {['left', 'center', 'right'].map(a => (
                        <button key={a} className={activeStyle.align === a ? 'on' : ''} onClick={() => applyStyle({ align: a })} title={`Align ${a}`}>
                            {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
                        </button>
                    ))}
                    <input type="color" value={activeStyle.color} onChange={(e) => applyStyle({ color: e.target.value })} title="Text colour" />
                    <select value={activeStyle.bg} onChange={(e) => applyStyle({ bg: e.target.value })} title="Fill colour">
                        {FILLS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select value={activeStyle.numberFormat} onChange={(e) => applyStyle({ numberFormat: e.target.value })} title="Number format (display only)">
                        {['general', 'number', 'currency', 'percent', 'date'].map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <button onClick={() => timed('Clear formatting', () => engine.clearStyles(range))} title="Clear formatting">⌫ fmt</button>
                </div>
                <div className="tb-group">
                    <button onClick={() => timed('Undo', () => engine.undo())} disabled={!engine.canUndo()} title={`Undo ${engine.undoLabel() ?? ''} (Ctrl+Z)`}>↶</button>
                    <button onClick={() => timed('Redo', () => engine.redo())} disabled={!engine.canRedo()} title={`Redo ${engine.redoLabel() ?? ''} (Ctrl+Y)`}>↷</button>
                </div>
                <div className="tb-group">
                    <button onClick={() => structural('Insert row')} title="Insert row above">+ Row</button>
                    <button onClick={() => structural('Delete row')} title="Delete selected rows">− Row</button>
                    <button onClick={() => structural('Insert column')} title="Insert column left">+ Col</button>
                    <button onClick={() => structural('Delete column')} title="Delete selected columns">− Col</button>
                    <select
                        value={frozenKey}
                        onChange={(e) => { const [rows, cols] = e.target.value.split(',').map(Number); timed('Freeze', () => engine.setFrozen({ rows, cols })) }}
                        title="Freeze panes"
                    >
                        <option value="0,0">No freeze</option>
                        <option value="1,0">Freeze row 1</option>
                        <option value="0,1">Freeze column A</option>
                        <option value="1,1">Freeze row 1 + col A</option>
                        {!['0,0', '1,0', '0,1', '1,1'].includes(frozenKey) && <option value={frozenKey}>Frozen {engine.frozen.rows} rows, {engine.frozen.cols} cols</option>}
                    </select>
                </div>
                <div className="tb-group">
                    <button onClick={() => timed('Clear', () => engine.clearContents(range))} title="Clear contents (Delete)">✕ Cells</button>
                    <button onClick={() => timed('Clear all', () => engine.clearAll())} title="Clear the whole sheet">✕ All</button>
                </div>
                <div className="tb-group">
                    <button onClick={() => loadSample('Load sales.tsv', loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
                    <button onClick={() => loadSample('Load sales-large.tsv', loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
                    <button onClick={() => loadSample('Generate 100k rows', loadSampleGenerated)} title="Generate 100,000 rows shaped like sales-large.tsv">⬇ 100k rows</button>
                </div>
                <div className="tb-group">
                    <button className={aiOpen ? 'on' : ''} onClick={() => setAiOpen(o => !o)} title="Assistant (Ctrl+K)">✦ Ask AI</button>
                </div>
            </header>

            <div className="formula-bar">
                <NameBox range={range} onJump={jump} />
                <span className="fx">fx</span>
                <Profiler id="formula-bar" onRender={countCommit}>
                    <FormulaInput
                        editStore={editStore}
                        editing={!!editing}
                        raw={engine.getRaw(active.r, active.c)}
                        onFocusEdit={() => { if (!editingRef.current) startEdit(active.r, active.c, { mode: 'edit', focusCell: false }) }}
                        onKeyDown={onEditorKeyDown}
                        onCommit={() => commitEdit()}
                    />
                </Profiler>
            </div>

            <div className="workspace">
                <div className="grid-wrap" onCopy={onCopy} onPaste={onPaste}>
                    <Profiler id="grid" onRender={countCommit}>
                    <Grid
                        engine={engine}
                        version={version}
                        selection={selection}
                        onSelectionChange={setSelection}
                        editing={editing}
                        editStore={editStore}
                        onStartEdit={startEdit}
                        onEditorKeyDown={onEditorKeyDown}
                        onCommitEdit={commitEdit}
                        onKeyDown={onGridKeyDown}
                        onOpenFilter={(col, anchor) => setFilterMenu({ col, anchor })}
                        onSort={onSort}
                        onAutoFit={autoFit}
                        onFill={onFill}
                        gridRef={gridRef}
                        onProfile={countCommit}
                    />
                    </Profiler>
                    {filterMenu && (
                        <FilterMenu
                            key={`${filterMenu.col}:${version}`}
                            engine={engine}
                            col={filterMenu.col}
                            anchor={filterMenu.anchor}
                            onClose={() => { setFilterMenu(null); gridRef.current?.focus() }}
                        />
                    )}
                </div>
                {aiOpen && (
                    <Suspense fallback={<aside className="ai-panel"><div className="ai-empty muted">Loading assistant…</div></aside>}>
                        <AiPanel engine={engine} selection={range} onClose={() => { setAiOpen(false); gridRef.current?.focus() }} />
                    </Suspense>
                )}
            </div>

            <footer className="status-bar">
                {filterStatus.active && (
                    <span className="status-filter">
                        {filterStatus.visible} of {filterStatus.total} rows
                        <button className="link" onClick={() => timed('Clear filters', () => engine.clearFilters())}>clear filters</button>
                    </span>
                )}
                {summary && (
                    <span>Count {summary.count}{summary.nums ? ` · Sum ${formatGeneralNumber(Math.round(summary.sum * 100) / 100)}` : ''}</span>
                )}
                <span className="spacer" />
                {perf && <span className="perf" title="Engine time, then time until the next frame was painted">{perf.label}: {perf.engineMs.toFixed(1)} ms engine · {perf.paintMs.toFixed(1)} ms to paint</span>}
                <span className="muted">Ctrl+K assistant · Ctrl+D fill down · drag the ■ to fill</span>
            </footer>
        </div>
    )
}
