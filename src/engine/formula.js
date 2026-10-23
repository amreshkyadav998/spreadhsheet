// ─────────────────────────────────────────────────────────────
//  Formulas: addresses, tokenizer, recursive-descent parser,
//  evaluator and reference rewriting. Pure, no engine state.
//
//  Grammar (after the leading '='):
//    expr    := term (('+' | '-') term)*
//    term    := power (('*' | '/') power)*
//    power   := unary ('^' unary)*
//    unary   := ('-' | '+') unary | primary
//    primary := number | string | ref (':' ref)? | NAME '(' args ')' | '(' expr ')' | '#REF!'
//  References may carry '$' on the column and/or the row: A1, $A1, A$1, $A$1.
// ─────────────────────────────────────────────────────────────

import { toNum } from './values.js'

// ── Addresses ──

export function colToLetters(col) {
    let label = ''
    let n = col + 1
    while (n > 0) {
        n--
        label = String.fromCharCode(65 + (n % 26)) + label
        n = Math.floor(n / 26)
    }
    return label
}

export function lettersToCol(letters) {
    let index = 0
    for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64)
    return index - 1
}

export function cellName(row, col) {
    return colToLetters(col) + (row + 1)
}

const CELL_NAME = /^\$?([A-Za-z]{1,3})\$?(\d+)$/

/** "B7" → { row: 6, col: 1 } (absolute markers ignored), or null. */
export function parseCellName(text) {
    const m = CELL_NAME.exec(String(text).trim())
    if (!m) return null
    const row = parseInt(m[2], 10) - 1
    if (row < 0) return null
    return { row, col: lettersToCol(m[1].toUpperCase()) }
}

/** "A1:C5" or "B2" → normalised { r1, c1, r2, c2 }, or null. */
export function parseRangeName(text) {
    const parts = String(text).trim().split(':')
    if (parts.length > 2) return null
    const a = parseCellName(parts[0])
    const b = parts.length === 2 ? parseCellName(parts[1]) : a
    if (!a || !b) return null
    return {
        r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
        r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
    }
}

export function rangeName(range) {
    const a = cellName(range.r1, range.c1)
    return range.r1 === range.r2 && range.c1 === range.c2 ? a : `${a}:${cellName(range.r2, range.c2)}`
}

// ── Errors ──

export class FormulaError {
    constructor(code) { this.code = code }
    toString() { return this.code }
}

export const ERR = Object.freeze({
    REF: '#REF!', VALUE: '#VALUE!', DIV0: '#DIV/0!', NAME: '#NAME?', CYCLE: '#CYCLE!', PARSE: '#PARSE!',
})

// ── Tokenizer ──
// Every token keeps its [start, end) offsets in the source so that
// reference rewriting can splice the original text.

const isDigit = (code) => code >= 48 && code <= 57
const isLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
// letters, digits, '_', '$', '.'
const isIdentChar = (code) => isLetter(code) || isDigit(code) || code === 95 || code === 36 || code === 46
const REF_TOKEN = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/
const NAME_TOKEN = /^[A-Za-z_][A-Za-z0-9_.]*$/
const NUMBER_TOKEN = /(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/y

export function tokenize(src) {
    const tokens = []
    let i = 0
    while (i < src.length) {
        const ch = src[i]
        const code = src.charCodeAt(i)
        if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue }
        const start = i
        if ('+-*/^(),:'.includes(ch)) {
            tokens.push({ type: ch, start, end: i + 1 })
            i++
            continue
        }
        if (ch === '"') {
            let value = ''
            i++
            while (i < src.length) {
                if (src[i] === '"') {
                    if (src[i + 1] === '"') { value += '"'; i += 2; continue }
                    break
                }
                value += src[i++]
            }
            if (src[i] !== '"') throw new FormulaError(ERR.PARSE)
            i++
            tokens.push({ type: 'str', value, start, end: i })
            continue
        }
        if (src.startsWith('#REF!', i)) {
            tokens.push({ type: 'err', value: ERR.REF, start, end: i + 5 })
            i += 5
            continue
        }
        if (isDigit(code) || ch === '.') {
            NUMBER_TOKEN.lastIndex = i
            const m = NUMBER_TOKEN.exec(src)
            if (!m) throw new FormulaError(ERR.PARSE)
            tokens.push({ type: 'num', value: parseFloat(m[0]), start, end: i + m[0].length })
            i += m[0].length
            continue
        }
        if (isIdentChar(code)) {
            while (i < src.length && isIdentChar(src.charCodeAt(i))) i++
            const text = src.slice(start, i)
            const m = REF_TOKEN.exec(text)
            if (m && src[i] !== '(') {
                tokens.push({
                    type: 'ref', start, end: i,
                    col: lettersToCol(m[2].toUpperCase()), row: parseInt(m[4], 10) - 1,
                    colAbs: m[1] === '$', rowAbs: m[3] === '$',
                })
            } else if (NAME_TOKEN.test(text)) {
                tokens.push({ type: 'name', value: text.toUpperCase(), start, end: i })
            } else {
                throw new FormulaError(ERR.PARSE)
            }
            continue
        }
        throw new FormulaError(ERR.PARSE)
    }
    return tokens
}

// ── Parser ──

export function parse(src) {
    const tokens = tokenize(src)
    let pos = 0
    const peek = () => tokens[pos]
    const take = (type) => {
        const t = tokens[pos]
        if (!t || (type && t.type !== type)) throw new FormulaError(ERR.PARSE)
        pos++
        return t
    }

    function expr() {
        let node = term()
        while (peek() && (peek().type === '+' || peek().type === '-')) {
            const op = take().type
            node = { t: 'bin', op, a: node, b: term() }
        }
        return node
    }
    function term() {
        let node = power()
        while (peek() && (peek().type === '*' || peek().type === '/')) {
            const op = take().type
            node = { t: 'bin', op, a: node, b: power() }
        }
        return node
    }
    function power() {
        let node = unary()
        while (peek() && peek().type === '^') {
            take()
            node = { t: 'bin', op: '^', a: node, b: unary() }
        }
        return node
    }
    function unary() {
        const t = peek()
        if (t && t.type === '-') { take(); return { t: 'neg', a: unary() } }
        if (t && t.type === '+') { take(); return unary() }
        return primary()
    }
    function primary() {
        const t = take()
        if (t.type === 'num') return { t: 'num', v: t.value }
        if (t.type === 'str') return { t: 'str', v: t.value }
        if (t.type === 'err') return { t: 'err', code: t.value }
        if (t.type === 'ref') {
            if (peek() && peek().type === ':') {
                take()
                const b = take('ref')
                return {
                    t: 'range',
                    r1: Math.min(t.row, b.row), c1: Math.min(t.col, b.col),
                    r2: Math.max(t.row, b.row), c2: Math.max(t.col, b.col),
                }
            }
            return { t: 'ref', row: t.row, col: t.col }
        }
        if (t.type === 'name') {
            take('(')
            const args = []
            if (peek() && peek().type !== ')') {
                args.push(expr())
                while (peek() && peek().type === ',') { take(); args.push(expr()) }
            }
            take(')')
            return { t: 'fn', name: t.value, args }
        }
        if (t.type === '(') {
            const node = expr()
            take(')')
            return node
        }
        throw new FormulaError(ERR.PARSE)
    }

    if (tokens.length === 0) throw new FormulaError(ERR.PARSE)
    const ast = expr()
    if (pos !== tokens.length) throw new FormulaError(ERR.PARSE)
    return ast
}

/** Collect the precedents of an AST: single cells and rectangular ranges. */
export function collectRefs(ast, out = { cells: [], ranges: [] }) {
    if (!ast) return out
    switch (ast.t) {
        case 'ref': out.cells.push(ast); break
        case 'range': out.ranges.push(ast); break
        case 'bin': collectRefs(ast.a, out); collectRefs(ast.b, out); break
        case 'neg': collectRefs(ast.a, out); break
        case 'fn': for (const a of ast.args) collectRefs(a, out); break
    }
    return out
}

/**
 * Compile a raw formula ("=..."). Never throws.
 * @returns {{ ast: object|null, error: string|null, cells: object[], ranges: object[] }}
 */
export function compile(raw) {
    try {
        const ast = parse(raw.slice(1))
        const { cells, ranges } = collectRefs(ast)
        return { ast, error: null, cells, ranges }
    } catch (e) {
        return { ast: null, error: e instanceof FormulaError ? e.code : ERR.PARSE, cells: [], ranges: [] }
    }
}

// ── Evaluator ──

function operand(v) {
    if (v instanceof FormulaError) throw v
    if (typeof v === 'number') return v
    if (v === '' || v === null || v === undefined) return 0
    const n = toNum(v)
    if (n === null) throw new FormulaError(ERR.VALUE)
    return n
}

function finite(n) {
    if (!Number.isFinite(n)) throw new FormulaError(ERR.VALUE)
    return n
}

/** Numbers an aggregate sees: range cells that coerce, scalar args strictly. */
function numericArgs(args, ctx) {
    const nums = []
    for (const arg of args) {
        if (arg.t === 'range') {
            ctx.forEachInRange(arg, (v) => {
                if (v instanceof FormulaError) throw v
                const n = toNum(v)
                if (n !== null) nums.push(n)
            })
        } else {
            nums.push(operand(evalNode(arg, ctx)))
        }
    }
    return nums
}

const FUNCTIONS = {
    SUM: (args, ctx) => numericArgs(args, ctx).reduce((s, n) => s + n, 0),
    AVERAGE: (args, ctx) => {
        const nums = numericArgs(args, ctx)
        if (nums.length === 0) throw new FormulaError(ERR.DIV0)
        return nums.reduce((s, n) => s + n, 0) / nums.length
    },
    MIN: (args, ctx) => { const n = numericArgs(args, ctx); return n.length ? Math.min(...n) : 0 },
    MAX: (args, ctx) => { const n = numericArgs(args, ctx); return n.length ? Math.max(...n) : 0 },
    COUNT: (args, ctx) => numericArgs(args, ctx).length,
    ABS: (args, ctx) => {
        if (args.length !== 1) throw new FormulaError(ERR.VALUE)
        return Math.abs(operand(evalNode(args[0], ctx)))
    },
    ROUND: (args, ctx) => {
        if (args.length < 1 || args.length > 2) throw new FormulaError(ERR.VALUE)
        const x = operand(evalNode(args[0], ctx))
        const d = args.length === 2 ? operand(evalNode(args[1], ctx)) : 0
        const f = Math.pow(10, Math.trunc(d))
        return Math.round(x * f) / f
    },
}
FUNCTIONS.AVG = FUNCTIONS.AVERAGE

function evalNode(node, ctx) {
    switch (node.t) {
        case 'num': return node.v
        case 'str': return node.v
        case 'err': throw new FormulaError(node.code)
        case 'ref': {
            const v = ctx.get(node.row, node.col)
            if (v instanceof FormulaError) throw v
            return v
        }
        case 'range': throw new FormulaError(ERR.VALUE)
        case 'neg': return -operand(evalNode(node.a, ctx))
        case 'bin': {
            const a = operand(evalNode(node.a, ctx))
            const b = operand(evalNode(node.b, ctx))
            switch (node.op) {
                case '+': return finite(a + b)
                case '-': return finite(a - b)
                case '*': return finite(a * b)
                case '/':
                    if (b === 0) throw new FormulaError(ERR.DIV0)
                    return finite(a / b)
                case '^': return finite(Math.pow(a, b))
            }
            throw new FormulaError(ERR.VALUE)
        }
        case 'fn': {
            const fn = FUNCTIONS[node.name]
            if (!fn) throw new FormulaError(ERR.NAME)
            return finite(fn(node.args, ctx))
        }
    }
    throw new FormulaError(ERR.VALUE)
}

/**
 * Evaluate a compiled AST.
 * ctx.get(row, col) → value | FormulaError; ctx.forEachInRange(range, fn).
 * A reference to an empty cell reads as 0 in arithmetic (spreadsheet convention).
 * @returns {number|string|FormulaError}
 */
export function evaluate(ast, ctx) {
    try {
        const v = evalNode(ast, ctx)
        return v === '' ? 0 : v
    } catch (e) {
        if (e instanceof FormulaError) return e
        throw e
    }
}

// ── Reference rewriting ──

function refText(ref) {
    return (ref.colAbs ? '$' : '') + colToLetters(ref.col) + (ref.rowAbs ? '$' : '') + (ref.row + 1)
}

/**
 * Rewrite every reference in a raw formula. The original text is kept
 * byte-for-byte except for references whose target changes.
 *
 * mapper.cell(ref)   → ref | null   (null becomes #REF!)
 * mapper.range(a, b) → [a, b] | null
 * where ref = { row, col, rowAbs, colAbs }.
 */
export function rewriteRefs(raw, mapper) {
    if (typeof raw !== 'string' || !raw.startsWith('=')) return raw
    let tokens
    try {
        tokens = tokenize(raw.slice(1))
    } catch {
        return raw
    }
    const offset = 1
    const edits = []
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.type !== 'ref') continue
        const isRange = tokens[i + 1] && tokens[i + 1].type === ':' && tokens[i + 2] && tokens[i + 2].type === 'ref'
        if (isRange) {
            const b = tokens[i + 2]
            const out = mapper.range(t, b)
            if (!out) {
                edits.push({ start: t.start, end: b.end, text: ERR.REF })
            } else {
                if (out[0].row !== t.row || out[0].col !== t.col) edits.push({ start: t.start, end: t.end, text: refText(out[0]) })
                if (out[1].row !== b.row || out[1].col !== b.col) edits.push({ start: b.start, end: b.end, text: refText(out[1]) })
            }
            i += 2
        } else {
            const out = mapper.cell(t)
            if (!out) edits.push({ start: t.start, end: t.end, text: ERR.REF })
            else if (out.row !== t.row || out.col !== t.col) edits.push({ start: t.start, end: t.end, text: refText(out) })
        }
    }
    if (edits.length === 0) return raw
    let result = raw
    for (let k = edits.length - 1; k >= 0; k--) {
        const e = edits[k]
        result = result.slice(0, e.start + offset) + e.text + result.slice(e.end + offset)
    }
    return result
}

/**
 * Copy a formula by (dRow, dCol), the way fill and paste do:
 * relative parts move, '$' parts stay. Off-sheet targets become #REF!.
 */
export function shiftFormula(raw, dRow, dCol) {
    if (dRow === 0 && dCol === 0) return raw
    const move = (ref) => {
        const row = ref.rowAbs ? ref.row : ref.row + dRow
        const col = ref.colAbs ? ref.col : ref.col + dCol
        return row < 0 || col < 0 ? null : { ...ref, row, col }
    }
    return rewriteRefs(raw, {
        cell: move,
        range: (a, b) => {
            const na = move(a), nb = move(b)
            return na && nb ? [na, nb] : null
        },
    })
}
