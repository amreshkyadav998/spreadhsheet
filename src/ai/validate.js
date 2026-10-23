// ─────────────────────────────────────────────────────────────
//  A small JSON Schema validator for the subset the contract uses:
//  type (incl. "integer" and type arrays), const, enum, required,
//  properties, additionalProperties: false, items, minimum, maximum,
//  pattern. Returns every failure with its JSON path.
// ─────────────────────────────────────────────────────────────

import { ACTION_TYPES, QUERY_PLAN_SCHEMA, FORMAT_SHEET_SCHEMA, CLARIFY_SCHEMA } from './contract.js'

function typeOf(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}

function matchesType(v, type) {
    switch (type) {
        case 'integer': return typeof v === 'number' && Number.isInteger(v)
        case 'number': return typeof v === 'number' && Number.isFinite(v)
        case 'array': return Array.isArray(v)
        case 'object': return typeOf(v) === 'object'
        case 'null': return v === null
        default: return typeof v === type
    }
}

/**
 * @returns {{ path: string, message: string }[]}  empty when valid
 */
export function validate(schema, value, path = '$') {
    const errors = []
    const fail = (message) => errors.push({ path, message })

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type]
        if (!types.some(t => matchesType(value, t))) {
            fail(`expected ${types.join(' or ')}, got ${typeOf(value)}`)
            return errors
        }
    }
    if ('const' in schema && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`)
    if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}; got ${JSON.stringify(value)}`)
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) fail(`must be ≥ ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) fail(`must be ≤ ${schema.maximum}`)
    }
    if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
        fail(`must match ${schema.pattern}`)
    }
    if (typeOf(value) === 'object') {
        for (const key of schema.required || []) {
            if (!(key in value)) errors.push({ path: `${path}.${key}`, message: 'is required' })
        }
        const props = schema.properties || {}
        for (const [key, v] of Object.entries(value)) {
            if (props[key]) errors.push(...validate(props[key], v, `${path}.${key}`))
            else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'is not allowed' })
        }
    }
    if (Array.isArray(value) && schema.items) {
        value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)))
    }
    return errors
}

const SCHEMAS = {
    [ACTION_TYPES.QUERY]: QUERY_PLAN_SCHEMA,
    [ACTION_TYPES.FORMAT_SHEET]: FORMAT_SHEET_SCHEMA,
    [ACTION_TYPES.CLARIFY]: CLARIFY_SCHEMA,
}

/**
 * Check a parsed model response against the contract.
 * Unknown action types are READ_ONLY refusals, not schema errors:
 * the assistant can only read, format, or ask.
 * @returns {{ ok: true, action: object } | { ok: false, error: string, message: string, details?: object[] }}
 */
export function validateAction(value) {
    if (typeOf(value) !== 'object') {
        return { ok: false, error: 'INVALID_RESPONSE', message: 'The response is not a JSON object.' }
    }
    if (typeof value.type !== 'string') {
        return { ok: false, error: 'INVALID_RESPONSE', message: 'The response has no "type".', details: [{ path: '$.type', message: 'is required' }] }
    }
    const schema = SCHEMAS[value.type]
    if (!schema) {
        return { ok: false, error: 'READ_ONLY', message: `"${value.type}" actions are not allowed. The assistant can only answer questions (query), format the sheet (format_sheet) or ask for clarification.` }
    }
    const details = validate(schema, value)
    if (details.length) {
        const summary = details.slice(0, 4).map(d => `${d.path} ${d.message}`).join('; ')
        return { ok: false, error: 'INVALID_RESPONSE', message: `The ${value.type} action failed validation: ${summary}`, details }
    }
    return { ok: true, action: value }
}
