// ─────────────────────────────────────────────────────────────
//  Value coercion shared by formulas, sort, filter, the query
//  executor and number formats. Pure functions, no state.
//  Rules follow AI_CONTRACT.md §3.2 so every feature reads
//  messy cells ("$1,200.00", "10%", "15 Jan 2024") the same way.
// ─────────────────────────────────────────────────────────────

const NUMERIC_BODY = /^-?\d+(\.\d+)?$/
const PLAIN_NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december']

/** Text key: trimmed, lower-cased. */
export function norm(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

export function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

/** True when a literal typed into a cell is a plain number ("12", "-3.5", "1e3"). */
export function isPlainNumber(text) {
    return typeof text === 'string' && PLAIN_NUMBER.test(text)
}

/**
 * Lenient number: "$1,200.00" → 1200, "10%" → 0.1, "$ 49.99" → 49.99,
 * "15 %" → 0.15, "N/A" → null, "" → null. Numbers pass through.
 */
export function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v === null || v === undefined || typeof v === 'boolean') return null
    let s = String(v).trim()
    if (s === '') return null
    const percent = s.endsWith('%')
    s = s.replace(/[$,%\s]/g, '')
    if (!NUMERIC_BODY.test(s)) return null
    const n = parseFloat(s)
    return percent ? n / 100 : n
}

// ── Dates ──
// Accepted: YYYY-M-D, M/D/YYYY, D Mon YYYY (English month, 3+ letters).

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const DMY_DATE = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/

function monthFromName(name) {
    const n = name.toLowerCase()
    if (n.length < 3) return -1
    return MONTHS.findIndex(m => m.startsWith(n))
}

function validYmd(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * Parse one of the three sample date formats.
 * @returns {{ y:number, m:number, d:number, format:'iso'|'us'|'dmy', pad:boolean, monthText?:string } | null}
 */
export function parseDateParts(v) {
    if (typeof v !== 'string') return null
    const s = v.trim()
    let m = ISO_DATE.exec(s)
    if (m) {
        const y = +m[1], mo = +m[2], d = +m[3]
        return validYmd(y, mo, d) ? { y, m: mo, d, format: 'iso', pad: m[2].length === 2 && m[3].length === 2 } : null
    }
    m = US_DATE.exec(s)
    if (m) {
        const y = +m[3], mo = +m[1], d = +m[2]
        return validYmd(y, mo, d) ? { y, m: mo, d, format: 'us', pad: m[1].length === 2 && m[2].length === 2 } : null
    }
    m = DMY_DATE.exec(s)
    if (m) {
        const mo = monthFromName(m[2]) + 1
        const y = +m[3], d = +m[1]
        if (mo < 1 || !validYmd(y, mo, d)) return null
        return { y, m: mo, d, format: 'dmy', pad: m[1].length === 2, monthText: m[2] }
    }
    return null
}

const pad2 = (n) => String(n).padStart(2, '0')

/** ISO day "YYYY-MM-DD" or null. */
export function toDate(v) {
    const p = parseDateParts(v)
    return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null
}

/** Days since 1970-01-01 (UTC) for a parsed date. */
export function dateToSerial(p) {
    return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000)
}

/** Inverse of dateToSerial, rendered in the same style as `like`. */
export function serialToDateText(serial, like) {
    const dt = new Date(serial * 86400000)
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate()
    if (like.format === 'us') return like.pad ? `${pad2(m)}/${pad2(d)}/${y}` : `${m}/${d}/${y}`
    if (like.format === 'dmy') {
        const full = MONTHS[m - 1]
        const text = like.monthText && like.monthText.length > 3 ? full : full.slice(0, 3)
        return `${like.pad ? pad2(d) : d} ${matchCase(text, like.monthText || 'Jan')} ${y}`
    }
    return like.pad === false ? `${y}-${m}-${d}` : `${y}-${pad2(m)}-${pad2(d)}`
}

/** Re-case `word` the way `sample` is cased: "MON", "mon", "Mon". */
export function matchCase(word, sample) {
    if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase()
    if (sample === sample.toLowerCase()) return word.toLowerCase()
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/**
 * Classify a computed value for sorting and type inference.
 * @returns {{ kind:'blank'|'number'|'date'|'text', num?:number, text?:string }}
 */
export function classify(v) {
    if (isBlank(v)) return { kind: 'blank' }
    if (typeof v === 'number') return { kind: 'number', num: v }
    const s = String(v)
    const n = toNum(s)
    if (n !== null) return { kind: 'number', num: n }
    const p = parseDateParts(s)
    if (p) return { kind: 'date', num: dateToSerial(p) }
    return { kind: 'text', text: norm(s) }
}
