// Column filter dropdown: search, checklist of distinct values (grouped
// case- and space-insensitively, with "(Blanks)"), and one condition.
import { useEffect, useMemo, useRef, useState } from 'react'
import { distinctValues } from '../engine/filter.js'
import { colToLetters } from '../engine/formula.js'

const MAX_LISTED = 500

const CONDITIONS = [
    { op: '', label: 'No condition' },
    { op: 'contains', label: 'Contains' },
    { op: 'gt', label: 'Greater than' },
    { op: 'lt', label: 'Less than' },
    { op: 'isEmpty', label: 'Is empty' },
]

export default function FilterMenu({ engine, col, anchor, onClose }) {
    const ref = useRef(null)
    const existing = engine.getFilters().get(col) || null
    const used = engine.getUsedRange()
    const header = used ? String(engine.getText(used.r1, col) || '') : ''

    const options = useMemo(() => {
        if (!used) return []
        const values = []
        for (let r = used.r1 + 1; r <= used.r2; r++) values.push(engine.getText(r, col))
        return distinctValues(values)
    }, [engine, col, used])

    const [search, setSearch] = useState('')
    const [checked, setChecked] = useState(() => new Set(existing?.values ?? options.map(o => o.key)))
    const [op, setOp] = useState(existing?.cond?.op ?? '')
    const [value, setValue] = useState(existing?.cond?.value ?? '')

    useEffect(() => {
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('mousedown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    const term = search.trim().toLowerCase()
    const visible = options.filter(o => !term || o.label.toLowerCase().includes(term))
    const allChecked = visible.every(o => checked.has(o.key))

    const toggle = (key) => setChecked(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })

    const toggleAll = () => setChecked(prev => {
        const next = new Set(prev)
        for (const o of visible) {
            if (allChecked) next.delete(o.key)
            else next.add(o.key)
        }
        return next
    })

    const apply = () => {
        const everything = options.every(o => checked.has(o.key))
        const values = everything ? null : options.filter(o => checked.has(o.key)).map(o => o.key)
        const cond = op ? { op, value: op === 'isEmpty' ? '' : value } : null
        engine.setFilter(col, values || cond ? { values, cond } : null)
        onClose()
    }

    const style = { left: Math.max(8, Math.min(anchor.left - 200, window.innerWidth - 280)), top: anchor.bottom + 4 }

    return (
        <div className="filter-menu" ref={ref} style={style} role="dialog" aria-label={`Filter column ${colToLetters(col)}`}>
            <div className="filter-title">Filter {colToLetters(col)}{header ? ` · ${header}` : ''}</div>
            <input className="filter-search" placeholder="Search values" value={search} autoFocus onChange={(e) => setSearch(e.target.value)} />
            <label className="filter-item all">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} /> (Select all{term ? ' shown' : ''})
            </label>
            <div className="filter-list">
                {visible.slice(0, MAX_LISTED).map(o => (
                    <label key={o.key} className="filter-item">
                        <input type="checkbox" checked={checked.has(o.key)} onChange={() => toggle(o.key)} />
                        <span className="filter-label">{o.label}</span>
                        <span className="filter-count">{o.count}</span>
                    </label>
                ))}
                {visible.length > MAX_LISTED && <div className="filter-more">…{visible.length - MAX_LISTED} more, refine the search</div>}
            </div>
            <div className="filter-cond">
                <select value={op} onChange={(e) => setOp(e.target.value)}>
                    {CONDITIONS.map(c => <option key={c.op} value={c.op}>{c.label}</option>)}
                </select>
                {op && op !== 'isEmpty' && (
                    <input value={value} placeholder={op === 'contains' ? 'text' : 'number or date'} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') apply() }} />
                )}
            </div>
            <div className="filter-actions">
                <button onClick={() => { engine.setFilter(col, null); onClose() }} disabled={!existing} title="Clear this column's filter">Clear</button>
                <button onClick={() => { engine.clearFilters(); onClose() }} title="Clear the filters of every column">Clear all</button>
                <span className="spacer" />
                <button onClick={onClose}>Cancel</button>
                <button className="primary" onClick={apply}>Apply</button>
            </div>
        </div>
    )
}
