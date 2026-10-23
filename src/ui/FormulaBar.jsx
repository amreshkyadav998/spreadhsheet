// Name box + formula bar. The formula input shares the cell editor's
// text store, so typing in either one updates both without a grid render.
import { useState } from 'react'
import { useStore } from './stores.js'
import { rangeName } from '../engine/formula.js'

export function NameBox({ range, onJump }) {
    const label = rangeName(range)
    const [draft, setDraft] = useState(null)
    const [error, setError] = useState(false)
    return (
        <input
            className={`name-box${error ? ' invalid' : ''}`}
            value={draft ?? label}
            title={error ? 'Not a cell or range, e.g. AZ5000 or A1:C10' : 'Name box: type a cell or range and press Enter'}
            spellCheck={false}
            onFocus={(e) => { setDraft(label); e.target.select() }}
            onChange={(e) => { setDraft(e.target.value); setError(false) }}
            onBlur={() => { setDraft(null); setError(false) }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    if (onJump(draft ?? label)) {
                        setDraft(null)
                        e.currentTarget.blur()
                    } else setError(true)
                } else if (e.key === 'Escape') {
                    setDraft(null)
                    e.currentTarget.blur()
                }
            }}
        />
    )
}

export function FormulaInput({ editStore, editing, raw, onFocusEdit, onKeyDown, onCommit }) {
    const text = useStore(editStore)
    return (
        <input
            className="formula-input"
            value={editing ? text : raw}
            spellCheck={false}
            placeholder="Value or formula, e.g. =SUM(J2:J32) or =$G$2*H2"
            onFocus={onFocusEdit}
            onChange={(e) => editStore.set(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
                if (e.relatedTarget && e.relatedTarget.classList?.contains('cell-editor')) return
                onCommit()
            }}
        />
    )
}
