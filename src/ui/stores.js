// ─────────────────────────────────────────────────────────────
//  Tiny external stores read with useSyncExternalStore. The cell
//  editor's text lives here so a keystroke re-renders the editor and
//  the formula bar only, never the grid.
// ─────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react'

export function createStore(initial) {
    let value = initial
    const listeners = new Set()
    return {
        get: () => value,
        set(next) {
            if (Object.is(next, value)) return
            value = next
            for (const fn of listeners) fn()
        },
        subscribe(fn) {
            listeners.add(fn)
            return () => listeners.delete(fn)
        },
    }
}

export function useStore(store) {
    return useSyncExternalStore(store.subscribe, store.get)
}

/** Re-render when the engine commits a change; returns its version. */
export function useEngineVersion(engine) {
    return useSyncExternalStore(engine.subscribe, () => engine.version)
}
