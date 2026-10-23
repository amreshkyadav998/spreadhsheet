// ─────────────────────────────────────────────────────────────
//  Virtualized grid. One native scroll container; frozen rows and
//  columns are position: sticky panes inside it, so headers stay in
//  sync with the body without any scroll JavaScript.
//
//  React renders only the visible window plus overscan. The window
//  is derived from a quantized scroll position, so scrolling inside
//  one quantum causes no render at all. There is no React state per
//  cell: every cell is read from the engine during render.
// ─────────────────────────────────────────────────────────────

import { Profiler, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createAxis } from './layout.js'
import { colToLetters } from '../engine/formula.js'
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from '../engine/core.js'
import { fillTargetFor } from '../engine/fill.js'
import { useStore } from './stores.js'

export const HEADER_W = 46
export const HEADER_H = 24
const QUANTUM_Y = 240
const QUANTUM_X = 400
const RESIZE_GRIP = 4
const MIN_COL = 24
const MIN_ROW = 14

const normRange = (a, b) => ({
    r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c),
})

function CellEditor({ editStore, style, onKeyDown, onBlur, inputRef }) {
    const text = useStore(editStore)
    return (
        <input
            ref={inputRef}
            className="cell-editor"
            style={style}
            value={text}
            spellCheck={false}
            onChange={(e) => editStore.set(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onMouseDown={(e) => e.stopPropagation()}
        />
    )
}

function Grid({
    engine, version, selection, onSelectionChange, editing, editStore, onStartEdit, onEditorKeyDown,
    onCommitEdit, onKeyDown, onOpenFilter, onSort, onAutoFit, onFill, gridRef, onProfile,
}) {
    const scrollerRef = useRef(null)
    const editorRef = useRef(null)
    const dragRef = useRef(null)
    const [view, setView] = useState({ top: 0, left: 0, w: 1400, h: 800 })
    const [fillPreview, setFillPreview] = useState(null)
    const [resizeGuide, setResizeGuide] = useState(null)

    // ── Layout from engine state (recomputed per committed change) ──
    const { rowAxis, colAxis, frozenRows, frozenCols, used, filters, sortState } = useMemo(() => {
        void version
        return {
            rowAxis: createAxis(engine.rows, DEFAULT_ROW_HEIGHT, engine.getSizeOverrides('row'), engine.getHiddenRows()),
            colAxis: createAxis(engine.cols, DEFAULT_COL_WIDTH, engine.getSizeOverrides('col')),
            frozenRows: Math.min(engine.frozen.rows, engine.rows),
            frozenCols: Math.min(engine.frozen.cols, engine.cols),
            used: engine.getUsedRange(),
            filters: engine.getFilters(),
            sortState: engine.getSortState(),
        }
    }, [engine, version])

    const frozenH = rowAxis.offsetOf(frozenRows)
    const frozenW = colAxis.offsetOf(frozenCols)
    const topH = HEADER_H + frozenH
    const leftW = HEADER_W + frozenW
    const canvasW = HEADER_W + colAxis.total
    const canvasH = HEADER_H + rowAxis.total

    // ── Visible window ──
    const win = useMemo(() => {
        const yFrom = Math.max(0, view.top - QUANTUM_Y) + frozenH
        const yTo = view.top + view.h + 2 * QUANTUM_Y
        const xFrom = Math.max(0, view.left - QUANTUM_X) + frozenW
        const xTo = view.left + view.w + 2 * QUANTUM_X
        return {
            r0: Math.max(frozenRows, rowAxis.indexAt(yFrom)),
            r1: Math.min(engine.rows - 1, rowAxis.indexAt(yTo)),
            c0: Math.max(frozenCols, colAxis.indexAt(xFrom)),
            c1: Math.min(engine.cols - 1, colAxis.indexAt(xTo)),
        }
    }, [view, rowAxis, colAxis, frozenRows, frozenCols, frozenH, frozenW, engine])

    const onScroll = useCallback(() => {
        const el = scrollerRef.current
        const top = Math.floor(el.scrollTop / QUANTUM_Y) * QUANTUM_Y
        const left = Math.floor(el.scrollLeft / QUANTUM_X) * QUANTUM_X
        setView(v => (v.top === top && v.left === left ? v : { ...v, top, left }))
    }, [])

    // First paint of the grid, for the first-paint budget (performance.getEntriesByName).
    useEffect(() => {
        performance.mark('grid-first-render')
    }, [])

    useEffect(() => {
        const el = scrollerRef.current
        const ro = new ResizeObserver(() => {
            setView(v => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { ...v, w: el.clientWidth, h: el.clientHeight }))
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    // ── Geometry ──
    const xOf = useCallback((c) => HEADER_W + colAxis.offsetOf(c), [colAxis])
    const yOf = useCallback((r) => HEADER_H + rowAxis.offsetOf(r), [rowAxis])

    /** Map a pointer to a grid position, honouring sticky panes. */
    const hitTest = useCallback((clientX, clientY, clamp = false) => {
        const el = scrollerRef.current
        const rect = el.getBoundingClientRect()
        let vx = clientX - rect.left
        let vy = clientY - rect.top
        if (clamp) {
            vx = Math.max(leftW, Math.min(vx, el.clientWidth - 1))
            vy = Math.max(topH, Math.min(vy, el.clientHeight - 1))
        }
        const inColHeader = vy < HEADER_H
        const inRowHeader = vx < HEADER_W
        const x = vx < leftW ? vx : vx + el.scrollLeft
        const y = vy < topH ? vy : vy + el.scrollTop
        const col = colAxis.indexAt(x - HEADER_W)
        const row = rowAxis.indexAt(y - HEADER_H)
        return { row, col, x, y, inColHeader, inRowHeader }
    }, [colAxis, rowAxis, leftW, topH])

    const borderAt = useCallback((hit) => {
        if (hit.inColHeader && !hit.inRowHeader) {
            const px = hit.x - HEADER_W
            const right = colAxis.offsetOf(hit.col + 1)
            if (right - px <= RESIZE_GRIP) return { axis: 'col', index: hit.col }
            if (px - colAxis.offsetOf(hit.col) <= RESIZE_GRIP && hit.col > 0) return { axis: 'col', index: colAxis.step(hit.col, -1) }
        }
        if (hit.inRowHeader && !hit.inColHeader) {
            const py = hit.y - HEADER_H
            const bottom = rowAxis.offsetOf(hit.row + 1)
            if (bottom - py <= RESIZE_GRIP) return { axis: 'row', index: hit.row }
            if (py - rowAxis.offsetOf(hit.row) <= RESIZE_GRIP && hit.row > 0) return { axis: 'row', index: rowAxis.step(hit.row, -1) }
        }
        return null
    }, [colAxis, rowAxis])

    // ── Imperative API for the app: scrolling, focus, page size ──
    useImperativeHandle(gridRef, () => ({
        scrollIntoView(r, c) {
            const el = scrollerRef.current
            if (!el) return
            if (r >= frozenRows) {
                const top = rowAxis.offsetOf(r), bottom = rowAxis.offsetOf(r + 1)
                const visTop = el.scrollTop + frozenH
                const visBottom = el.scrollTop + el.clientHeight - HEADER_H
                if (top < visTop) el.scrollTop = top - frozenH
                else if (bottom > visBottom) el.scrollTop = bottom - el.clientHeight + HEADER_H
            }
            if (c >= frozenCols) {
                const left = colAxis.offsetOf(c), right = colAxis.offsetOf(c + 1)
                const visLeft = el.scrollLeft + frozenW
                const visRight = el.scrollLeft + el.clientWidth - HEADER_W
                if (left < visLeft) el.scrollLeft = left - frozenW
                else if (right > visRight) el.scrollLeft = right - el.clientWidth + HEADER_W
            }
        },
        focus() { scrollerRef.current?.focus({ preventScroll: true }) },
        focusEditor() { editorRef.current?.focus() },
        pageRows() { return Math.max(1, Math.floor((view.h - topH) / DEFAULT_ROW_HEIGHT) - 1) },
        rowAxis, colAxis,
    }), [rowAxis, colAxis, frozenRows, frozenCols, frozenH, frozenW, topH, view.h])

    // ── Pointer interaction ──
    const range = normRange(selection.anchor, selection.focus)

    const autoScroll = useCallback((clientX, clientY) => {
        const el = scrollerRef.current
        const rect = el.getBoundingClientRect()
        let dx = 0, dy = 0
        if (clientY > rect.bottom - 8) dy = 24
        else if (clientY < rect.top + topH && el.scrollTop > 0) dy = -24
        if (clientX > rect.right - 8) dx = 40
        else if (clientX < rect.left + leftW && el.scrollLeft > 0) dx = -40
        if (dx) el.scrollLeft += dx
        if (dy) el.scrollTop += dy
        return dx !== 0 || dy !== 0
    }, [topH, leftW])

    const startDrag = useCallback((mode, payload) => {
        dragRef.current = { mode, ...payload, lastX: 0, lastY: 0, raf: 0 }
        const step = () => {
            const d = dragRef.current
            if (!d) return
            if (autoScroll(d.lastX, d.lastY)) d.onMove(d.lastX, d.lastY)
            d.raf = requestAnimationFrame(step)
        }
        const move = (e) => {
            const d = dragRef.current
            if (!d) return
            d.lastX = e.clientX
            d.lastY = e.clientY
            d.onMove(e.clientX, e.clientY)
        }
        const up = (e) => {
            const d = dragRef.current
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            if (d) {
                cancelAnimationFrame(d.raf)
                dragRef.current = null
                d.onUp?.(e.clientX, e.clientY)
            }
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        dragRef.current.raf = requestAnimationFrame(step)
    }, [autoScroll])

    const onMouseDown = useCallback((e) => {
        if (e.button !== 0) return
        const hit = hitTest(e.clientX, e.clientY)
        const border = borderAt(hit)
        if (border) {
            e.preventDefault()
            const axis = border.axis === 'col' ? colAxis : rowAxis
            const start = axis.sizeOf(border.index)
            const origin = border.axis === 'col' ? e.clientX : e.clientY
            const guide = { ...border, size: start }
            setResizeGuide(guide)
            startDrag('resize', {
                onMove: (x, y) => {
                    const delta = (border.axis === 'col' ? x : y) - origin
                    guide.size = Math.max(border.axis === 'col' ? MIN_COL : MIN_ROW, Math.round(start + delta))
                    setResizeGuide({ ...guide })
                },
                onUp: () => {
                    setResizeGuide(null)
                    if (guide.size === start) return
                    if (border.axis === 'col') engine.setColWidth(border.index, guide.size)
                    else engine.setRowHeight(border.index, guide.size)
                },
            })
            return
        }
        e.preventDefault()
        scrollerRef.current.focus({ preventScroll: true })
        if (editing) onCommitEdit()
        const lastRow = engine.rows - 1, lastCol = engine.cols - 1
        if (hit.inColHeader && hit.inRowHeader) {
            onSelectionChange({ anchor: { r: 0, c: 0 }, focus: { r: lastRow, c: lastCol } })
            return
        }
        if (hit.inColHeader) {
            const anchorCol = e.shiftKey ? selection.anchor.c : hit.col
            onSelectionChange({ anchor: { r: 0, c: anchorCol }, focus: { r: lastRow, c: hit.col } })
            startDrag('cols', {
                onMove: (x, y) => {
                    const h = hitTest(x, y, true)
                    onSelectionChange({ anchor: { r: 0, c: anchorCol }, focus: { r: lastRow, c: h.col } })
                },
            })
            return
        }
        if (hit.inRowHeader) {
            const anchorRow = e.shiftKey ? selection.anchor.r : hit.row
            onSelectionChange({ anchor: { r: anchorRow, c: 0 }, focus: { r: hit.row, c: lastCol } })
            startDrag('rows', {
                onMove: (x, y) => {
                    const h = hitTest(x, y, true)
                    onSelectionChange({ anchor: { r: anchorRow, c: 0 }, focus: { r: h.row, c: lastCol } })
                },
            })
            return
        }
        const anchor = e.shiftKey ? selection.anchor : { r: hit.row, c: hit.col }
        onSelectionChange({ anchor, focus: { r: hit.row, c: hit.col } })
        startDrag('cells', {
            onMove: (x, y) => {
                const h = hitTest(x, y, true)
                onSelectionChange(prev => (prev.focus.r === h.row && prev.focus.c === h.col ? prev : { anchor, focus: { r: h.row, c: h.col } }))
            },
        })
    }, [hitTest, borderAt, colAxis, rowAxis, startDrag, engine, editing, onCommitEdit, onSelectionChange, selection])

    const onFillHandleDown = useCallback((e) => {
        e.preventDefault()
        e.stopPropagation()
        if (editing) onCommitEdit()
        const source = range
        let target = source
        setFillPreview(source)
        startDrag('fill', {
            onMove: (x, y) => {
                const h = hitTest(x, y, true)
                target = fillTargetFor(source, h.row, h.col)
                setFillPreview(target)
            },
            onUp: () => {
                setFillPreview(null)
                if (target.r1 === source.r1 && target.r2 === source.r2 && target.c1 === source.c1 && target.c2 === source.c2) return
                onFill(source, target)
            },
        })
    }, [range, editing, onCommitEdit, startDrag, hitTest, onFill])

    const onDoubleClick = useCallback((e) => {
        const hit = hitTest(e.clientX, e.clientY)
        const border = borderAt(hit)
        if (border && border.axis === 'col') {
            onAutoFit(border.index)
            return
        }
        if (border && border.axis === 'row') {
            engine.setRowHeight(border.index, DEFAULT_ROW_HEIGHT)
            return
        }
        if (!hit.inColHeader && !hit.inRowHeader) onStartEdit(hit.row, hit.col, { mode: 'edit' })
    }, [hitTest, borderAt, onAutoFit, onStartEdit, engine])

    const onMouseMove = useCallback((e) => {
        if (dragRef.current) return
        const border = borderAt(hitTest(e.clientX, e.clientY))
        const cursor = border ? (border.axis === 'col' ? 'col-resize' : 'row-resize') : ''
        if (scrollerRef.current.style.cursor !== cursor) scrollerRef.current.style.cursor = cursor
    }, [borderAt, hitTest])

    // Focus the in-cell editor whenever editing starts.
    useEffect(() => {
        if (editing && editing.focusCell !== false) editorRef.current?.focus()
    }, [editing])

    // ── Rendering ──
    const isRowVisible = (r) => rowAxis.sizeOf(r) > 0

    function renderCell(r, c, dy) {
        const w = colAxis.sizeOf(c)
        const h = rowAxis.sizeOf(r)
        if (w === 0 || h === 0) return null
        const st = engine.getStoredStyle(r, c)
        const text = engine.getDisplay(r, c)
        const error = text !== '' && engine.getCell(r, c).error
        const align = st?.align || (typeof engine.getValue(r, c) === 'number' && !error ? 'right' : 'left')
        const style = {
            left: xOf(c), top: yOf(r) + dy, width: w, height: h,
            justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
        }
        if (st) {
            if (st.bg && st.bg !== 'white') style.background = st.bg
            if (st.bold) style.fontWeight = 600
            if (st.italic) style.fontStyle = 'italic'
            if (st.underline) style.textDecoration = 'underline'
            if (st.color) style.color = st.color
            if (st.fontSize) style.fontSize = st.fontSize
        }
        return (
            <div key={`${r}:${c}`} className={error ? 'cell cell-error' : 'cell'} style={style}>
                {text}
            </div>
        )
    }

    function renderCells(r0, r1, c0, c1, dy) {
        const out = []
        for (let r = r0; r <= r1; r++) {
            if (!isRowVisible(r)) continue
            for (let c = c0; c <= c1; c++) out.push(renderCell(r, c, dy))
        }
        return out
    }

    const inSel = (c) => c >= range.c1 && c <= range.c2
    const showControls = used && used.r2 > used.r1

    function renderColHeaders(c0, c1) {
        const out = []
        for (let c = c0; c <= c1; c++) {
            const w = colAxis.sizeOf(c)
            if (w === 0) continue
            const controls = showControls && c >= used.c1 && c <= used.c2
            const filtered = filters.has(c)
            const sorted = sortState && sortState.col === c ? sortState.dir : null
            out.push(
                <div key={`h${c}`} className={`col-header${inSel(c) ? ' active' : ''}`} style={{ left: xOf(c), width: w }}>
                    <span className="col-label">{colToLetters(c)}</span>
                    {controls && (
                        <span className="header-buttons">
                            <button
                                className={`hdr-btn${sorted ? ' on' : ''}`}
                                title="Sort: ascending → descending → original order"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => { e.stopPropagation(); onSort(c) }}
                            >{sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '↕'}</button>
                            <button
                                className={`hdr-btn${filtered ? ' on' : ''}`}
                                title="Filter"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => { e.stopPropagation(); onOpenFilter(c, e.currentTarget.getBoundingClientRect()) }}
                            >{filtered ? '⧩' : '▾'}</button>
                        </span>
                    )}
                </div>,
            )
        }
        return out
    }

    function renderRowHeaders(r0, r1, dy) {
        const out = []
        for (let r = r0; r <= r1; r++) {
            const h = rowAxis.sizeOf(r)
            if (h === 0) continue
            out.push(
                <div key={`r${r}`} className={`row-header${r >= range.r1 && r <= range.r2 ? ' active' : ''}`} style={{ top: yOf(r) + dy, height: h }}>
                    {r + 1}
                </div>,
            )
        }
        return out
    }

    function rectOf(rg) {
        const left = xOf(rg.c1), top = yOf(rg.r1)
        return { left, top, width: xOf(rg.c2 + 1) - left, height: yOf(rg.r2 + 1) - top }
    }

    const selRect = rectOf(range)
    const activeRect = rectOf({ r1: selection.anchor.r, c1: selection.anchor.c, r2: selection.anchor.r, c2: selection.anchor.c })
    const previewRect = fillPreview ? rectOf(fillPreview) : null
    const multi = range.r1 !== range.r2 || range.c1 !== range.c2

    function renderSelection(dy) {
        return (
            <>
                {multi && <div className="sel-range" style={{ ...selRect, top: selRect.top + dy }} />}
                <div className="sel-active" style={{ ...activeRect, top: activeRect.top + dy }} />
                {previewRect && <div className="fill-preview" style={{ ...previewRect, top: previewRect.top + dy }} />}
                {!editing && (
                    <div
                        className="fill-handle"
                        title="Drag to fill"
                        style={{ left: selRect.left + selRect.width - 4, top: selRect.top + selRect.height - 4 + dy }}
                        onMouseDown={onFillHandleDown}
                    />
                )}
            </>
        )
    }

    // Editor: placed in the layer that owns the edited cell.
    let editor = null
    let editorLayer = null
    if (editing) {
        const r = editing.r, c = editing.c
        const st = engine.getStyle(r, c)
        const rect = rectOf({ r1: r, c1: c, r2: r, c2: c })
        editorLayer = r < frozenRows ? (c < frozenCols ? 'corner' : 'top') : (c < frozenCols ? 'left' : 'body')
        const dy = editorLayer === 'left' ? -topH : 0
        editor = (
            <Profiler id="cell-editor" onRender={onProfile}>
            <CellEditor
                editStore={editStore}
                inputRef={editorRef}
                onKeyDown={onEditorKeyDown}
                onBlur={(e) => {
                    // Clicking the formula bar keeps the edit going.
                    if (e.relatedTarget && e.relatedTarget.classList?.contains('formula-input')) return
                    onCommitEdit()
                }}
                style={{
                    left: rect.left, top: rect.top + dy, minWidth: rect.width, height: rect.height,
                    fontWeight: st.bold ? 600 : 400, fontStyle: st.italic ? 'italic' : 'normal',
                    fontSize: st.fontSize, textAlign: st.align, background: st.bg === 'white' ? '#fff' : st.bg, color: st.color,
                }}
            />
            </Profiler>
        )
    }

    const guide = resizeGuide && (resizeGuide.axis === 'col'
        ? <div className="resize-guide col" style={{ left: xOf(resizeGuide.index) + resizeGuide.size - 1, height: canvasH }} />
        : <div className="resize-guide row" style={{ top: yOf(resizeGuide.index) + resizeGuide.size - 1, width: canvasW }} />)

    return (
        <div
            className="grid-scroller"
            ref={scrollerRef}
            tabIndex={0}
            onScroll={onScroll}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
        >
            <div className="grid-canvas" style={{ width: canvasW, height: canvasH }}>
                <div className="pane pane-top" style={{ width: canvasW, height: topH }}>
                    <div className="pane pane-corner" style={{ width: leftW, height: topH }}>
                        <div className="corner-cell" style={{ width: HEADER_W, height: HEADER_H }} title="Select all" />
                        {renderColHeaders(0, frozenCols - 1)}
                        {renderRowHeaders(0, frozenRows - 1, 0)}
                        {renderCells(0, frozenRows - 1, 0, frozenCols - 1, 0)}
                        {renderSelection(0)}
                        {editorLayer === 'corner' && editor}
                    </div>
                    {renderColHeaders(win.c0, win.c1)}
                    {renderCells(0, frozenRows - 1, win.c0, win.c1, 0)}
                    {renderSelection(0)}
                    {editorLayer === 'top' && editor}
                    {frozenRows > 0 && <div className="freeze-line h" style={{ top: topH - 1, width: canvasW }} />}
                </div>
                <div className="pane pane-left" style={{ width: leftW, height: canvasH - topH }}>
                    {renderRowHeaders(win.r0, win.r1, -topH)}
                    {renderCells(win.r0, win.r1, 0, frozenCols - 1, -topH)}
                    {renderSelection(-topH)}
                    {editorLayer === 'left' && editor}
                    {frozenCols > 0 && <div className="freeze-line v" style={{ left: leftW - 1, height: canvasH - topH }} />}
                </div>
                <div className="pane-body">
                    {renderCells(win.r0, win.r1, win.c0, win.c1, 0)}
                    {renderSelection(0)}
                    {editorLayer === 'body' && editor}
                    {guide}
                </div>
            </div>
        </div>
    )
}

export default memo(Grid)
