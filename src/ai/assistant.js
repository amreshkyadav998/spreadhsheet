// ─────────────────────────────────────────────────────────────
//  Prompt → provider → parse → validate. Pure orchestration with no
//  React; the panel calls ask() and then runs the action through the
//  executor (query) or the applier (format_sheet).
// ─────────────────────────────────────────────────────────────

import { SYSTEM_PROMPT, buildUserTurn } from './prompt.js'
import { extractJson } from './parse.js'
import { validateAction } from './validate.js'

const HISTORY_TURNS = 6

/**
 * @param {{ provider, prompt: string, context: object, history?: {role,content}[] }} args
 * @returns {Promise<{ ok: true, action: object, raw: string }
 *                 | { ok: false, error: string, message: string, raw?: string, details?: object[] }>}
 */
export async function ask({ provider, prompt, context, history = [] }) {
    let raw
    try {
        const res = await provider.complete({
            system: SYSTEM_PROMPT,
            user: buildUserTurn(context, prompt),
            history: history.slice(-HISTORY_TURNS),
        })
        raw = res.text
    } catch (e) {
        const kind = e && e.kind ? ` [${e.kind}]` : ''
        return { ok: false, error: 'PROVIDER_ERROR', message: `${e?.message || String(e)}${kind}` }
    }
    const parsed = extractJson(raw)
    if (!parsed.ok) return { ok: false, error: 'INVALID_RESPONSE', message: parsed.message, raw }
    const checked = validateAction(parsed.value)
    if (!checked.ok) return { ...checked, raw }
    return { ok: true, action: checked.action, raw }
}
