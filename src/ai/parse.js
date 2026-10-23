// ─────────────────────────────────────────────────────────────
//  Pull the first JSON object out of model text. Models wrap JSON
//  in prose and code fences; we scan for balanced braces (string-
//  and escape-aware) and return the first candidate that parses.
// ─────────────────────────────────────────────────────────────

/** End index (exclusive) of the balanced object starting at `start`, or -1. */
function matchObject(text, start) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return i + 1
        }
    }
    return -1
}

/**
 * @returns {{ ok: true, value: object, json: string } | { ok: false, message: string }}
 */
export function extractJson(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, message: 'The model returned an empty response.' }
    }
    let firstError = null
    for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
        const end = matchObject(text, start)
        if (end === -1) {
            firstError ??= 'The JSON object in the response is not closed.'
            continue
        }
        const json = text.slice(start, end)
        try {
            const value = JSON.parse(json)
            if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value, json }
        } catch (e) {
            firstError ??= `The response contains malformed JSON: ${e.message}`
        }
    }
    return { ok: false, message: firstError ?? 'The response contains no JSON object.' }
}
