// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output; parsing and validation happen in
//  src/ai/assistant.js. Failures are thrown as ProviderError with a
//  `kind` (network | auth | rate_limit | server | bad_request | refusal)
//  so the panel can say what went wrong.
//
//    • mock — deterministic, offline, answers fixtures/ai-eval/*.json.
//    • http — Anthropic Messages API over plain fetch(). This file is
//             the only place that knows the vendor.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-opus-5-5'
const API_VERSION = '2026-10-21'

export class ProviderError extends Error {
    constructor(kind, message, status) {
        super(message)
        this.name = 'ProviderError'
        this.kind = kind
        this.status = status
    }
}

async function readError(res) {
    try {
        const body = await res.json()
        return body?.error?.message || JSON.stringify(body)
    } catch {
        return res.statusText || 'no details'
    }
}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint || env.VITE_AI_ENDPOINT || DEFAULT_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model || env.VITE_AI_MODEL || DEFAULT_MODEL
    const fetchImpl = config.fetch || ((...args) => fetch(...args))

    return {
        name: 'http',
        async complete({ system, user, history = [] }) {
            if (!apiKey) throw new ProviderError('auth', 'No API key: set VITE_AI_API_KEY in .env.local (see .env.example).')
            let res
            try {
                res = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': API_VERSION,
                        'anthropic-beta': 'server-side-fallback-2026-07-01',
                        // The key lives in the browser for this demo; see DESIGN_NOTES.md.
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify({
                        model,
                        max_tokens: 16000,
                        system,
                        // Translating a request into a small JSON plan is a light task.
                        output_config: { effort: 'low' },
                        fallbacks: 'default',
                        messages: [...history, { role: 'user', content: user }],
                    }),
                })
            } catch (e) {
                throw new ProviderError('network', `Network error: could not reach ${endpoint} (${e.message}).`)
            }
            if (!res.ok) {
                const detail = await readError(res)
                if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `Authentication failed (${res.status}): ${detail}`, res.status)
                if (res.status === 429) {
                    const retry = res.headers.get('retry-after')
                    throw new ProviderError('rate_limit', `Rate limited (429)${retry ? `, retry after ${retry}s` : ''}: ${detail}`, 429)
                }
                if (res.status >= 500) throw new ProviderError('server', `Provider unavailable (${res.status}): ${detail}`, res.status)
                throw new ProviderError('bad_request', `Request rejected (${res.status}): ${detail}`, res.status)
            }
            const data = await res.json()
            if (data.stop_reason === 'refusal') {
                throw new ProviderError('refusal', `The model declined this request${data.stop_details?.explanation ? `: ${data.stop_details.explanation}` : '.'}`)
            }
            const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
            return { text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
